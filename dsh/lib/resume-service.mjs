// resume-service.mjs — dsh-hook 的 DSH 会话续聊服务（运行在 dsh web 进程内）
//
// a4p（续聊守护进程 a4p listen / 手动 a4p resume）把手机消息写成
// ~/.a4phone/dsh-jobs/req-<id>.json；本服务轮询该目录，对每个请求：
//   1. 解析出目标 agent（请求指定 sessionId 且仍 live → 用之；否则最近的
//      顶层会话 root agent）
//   2. agent.followup(用户消息) —— 与桌面端 web GUI 完全相同的会话、相同
//      的模型配置；消息以 user/message 事件写入会话日志，桌面端实时可见
//   3. await agent.whenIdle() 等待该轮次彻底结束
//   4. 从会话事件日志中提取最后一条 assistant 文本作为回复
//   5. 写 ~/.a4phone/dsh-jobs/resp-<id>.json 供 a4p 轮询取回
//
// 与官方 dsh-headless runner 的驱动方式一致（followup + whenIdle + 提取
// 最后 assistant 文本）。请求文件先删除再处理（at-most-once 语义：进程中途
// 崩溃不会导致同一条手机消息被重复注入会话）。
//
// 协议（a4p ↔ 插件，同一台机器，目录 = DSH_JOB_DIR）：
//   req-<id>.json  { id, sessionId?, text, ts }    a4p 原子写入
//   resp-<id>.json { id, ok, reply?, reasonKind?, error?, sessionId? }
//   dsh-heartbeat.json { alive: true, ts }          每次轮询刷新

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DSH_JOB_DIR, DSH_HEARTBEAT } from '../../src/paths.mjs';

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_MAX_AGE_MS = 10_000; // a4p 据此判断 dsh web 是否存活
// 孤儿 resp 文件清理：daemon 读取后即删；超过该时长仍未取走的视为遗留，回收
const ORPHAN_RESP_MAX_AGE_MS = 60 * 60 * 1000;

/** 正在被续聊服务驱动的会话集合（用于抑制任务完成推送的重复通知） */
const inflightResume = new Set();

/** 续聊是否正在驱动该会话（turn/end 钩子据此跳过手机"任务完成"推送） */
export function isResumeInflight(sessionId) {
  return inflightResume.has(sessionId);
}

/**
 * 从会话事件日志中提取续聊轮次的回复（纯函数，便于测试）。
 * 语义与 dsh-headless 的 summarize 对齐：只统计 seq >= boundarySeq 的事件，
 * 取其中最后一条非空 assistant 文本；reasonKind 为该区间最后一个 turn/end。
 * @param {Array<{seq:number,type:string,data?:any}>} events 会话事件快照（按 seq 升序）
 * @param {number} boundarySeq followup 前的 seq（日志长度）
 * @returns {{ reply: string|null, reasonKind: string|null, turn: number|null }}
 */
export function extractReply(events, boundarySeq) {
  let reasonKind = null;
  let turn = null;
  let reply = null;
  for (const event of events) {
    if (event.seq < boundarySeq) continue;
    if (event.type === 'turn/end') {
      reasonKind = event.data?.reason?.kind ?? null;
      turn = event.data?.turn ?? null;
    }
    if (event.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (text) reply = text;
    }
  }
  return { reply, reasonKind, turn };
}

/** 取最近一个顶层（非 subagent）会话作为兜底续聊目标 */
function mostRecentRoot(agents) {
  const roots = agents.roots?.() ?? [];
  return roots.length ? roots[roots.length - 1] : null;
}

/** 解析目标 agent：请求指定 sessionId 且仍 live → 用之；否则最近的 root */
function resolveAgent(agents, req) {
  if (req.sessionId) {
    const agent = agents.get?.(req.sessionId);
    if (agent) return agent;
  }
  return mostRecentRoot(agents);
}

/** 原子写 JSON 文件（临时文件 + rename，避免读者读到半个文件） */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

/** 构造一条普通用户消息（与 createUserMessage 等价，不引入 @deepseek-ai 依赖） */
function buildUserMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * 在指定 agent 上执行一轮续聊：注入用户消息 → 等待轮次结束 → 提取回复。
 * 与桌面端共享同一个 live 会话（同一模型配置，消息与回复实时写入会话日志）。
 * @param {object} agent Agent（agent.followup / whenIdle / session）
 * @param {string} text 续聊内容
 * @returns {Promise<{reply:string|null, reasonKind:string|null, turn:number|null, failed:boolean, error:string|null, sessionId:string}>}
 */
export async function executeResumeTurn(agent, text) {
  const boundarySeq = agent.session.seq;
  inflightResume.add(agent.id);
  try {
    agent.followup(buildUserMessage(text));
    await agent.whenIdle();
    const { reply, reasonKind, turn } = extractReply(agent.session.events, boundarySeq);
    const failed =
      reasonKind === 'error' || reasonKind === 'aborted' ||
      reasonKind === 'cancelled' || reasonKind === 'blocked';
    return {
      reply: reply || null,
      reasonKind: reasonKind ?? null,
      turn: turn ?? null,
      failed,
      error: failed
        ? `会话轮次结束状态：${reasonKind}${reasonKind === 'error' ? '（模型调用失败）' : ''}`
        : null,
      sessionId: agent.id,
    };
  } catch (error) {
    return {
      reply: null,
      reasonKind: null,
      turn: null,
      failed: true,
      error: `续聊执行异常：${error instanceof Error ? error.message : String(error)}`,
      sessionId: agent.id,
    };
  } finally {
    inflightResume.delete(agent.id);
  }
}

/**
 * 处理一条续聊请求：解析目标 agent → 执行续聊 → 写 resp 文件。
 * 注意：调用方应确保 agents 服务可用（否则跳过，保留请求文件）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agents AgentRegistry 服务（ctx.get('agents')）
 * @param {{id:string, sessionId?:string|null, text:string}} req
 * @param {string} [dir] 响应文件目录（默认 DSH_JOB_DIR）
 */
async function processRequest(ctx, agents, req, dir = DSH_JOB_DIR) {
  const text = String(req?.text ?? '').trim();
  if (!text) {
    atomicWriteJson(respPath(req.id, dir), { id: req.id, ok: false, error: '续聊内容为空。' });
    return;
  }

  const agent = resolveAgent(agents, req);
  if (!agent) {
    atomicWriteJson(respPath(req.id, dir), {
      id: req.id,
      ok: false,
      error: '没有可续聊的 DSH 会话（请先在桌面端开始并完成一轮会话）。',
    });
    return;
  }

  const outcome = await executeResumeTurn(agent, text);
  atomicWriteJson(respPath(req.id, dir), {
    id: req.id,
    ok: !outcome.failed,
    reply: outcome.reply,
    reasonKind: outcome.reasonKind,
    turn: outcome.turn,
    sessionId: outcome.sessionId,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}

function respPath(id, dir = DSH_JOB_DIR) {
  return path.join(dir, `resp-${id}.json`);
}

/**
 * 启动续聊服务：定期扫描请求目录 + 刷新心跳。返回停止函数（卸载时调用）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{dir?:string, heartbeatPath?:string}} [opts] 覆盖队列目录/心跳路径（测试用）
 */
export function startResumeService(ctx, { dir = DSH_JOB_DIR, heartbeatPath = DSH_HEARTBEAT } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let busy = false;

  const scan = async () => {
    // 心跳：a4p 守护进程据此判断 dsh web 是否在运行（快速失败而非干等超时）
    try {
      atomicWriteJson(heartbeatPath, { alive: true, ts: Date.now() });
    } catch {}
    if (busy) return;
    busy = true;
    try {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.startsWith('req-') && f.endsWith('.json'));
      } catch {
        return;
      }
      // 清理孤儿 resp（daemon 未取走的遗留文件）
      try {
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith('resp-') || !f.endsWith('.json')) continue;
          const p = path.join(dir, f);
          try {
            if (now - fs.statSync(p).mtimeMs > ORPHAN_RESP_MAX_AGE_MS) fs.unlinkSync(p);
          } catch {}
        }
      } catch {}
      for (const f of files.sort()) {
        const id = f.slice('req-'.length, -'.json'.length);
        const reqPath = path.join(dir, f);
        let req;
        try {
          req = JSON.parse(fs.readFileSync(reqPath, 'utf-8'));
        } catch {
          // 请求文件损坏（如带 BOM / 半截写入）：写错误响应而非静默丢弃，
          // 让 a4p 能给用户明确提示而不是干等超时
          try { fs.unlinkSync(reqPath); } catch {}
          try {
            atomicWriteJson(respPath(id, dir), { id, ok: false, error: '续聊请求格式无效（文件损坏或被截断）。' });
          } catch {}
          continue;
        }
        // agents 服务未就绪（插件挂载初期）：保留请求文件，等下一轮扫描
        const agents = ctx.get('agents');
        if (!agents) continue;
        // 先删请求文件再处理（at-most-once：崩溃不会重复注入同一条消息）
        try { fs.unlinkSync(reqPath); } catch {}
        try {
          await processRequest(ctx, agents, req, dir);
        } catch (error) {
          ctx?.logger?.warn?.(`dsh-resume: 请求 ${id} 处理失败: ${String(error)}`);
          try {
            atomicWriteJson(respPath(id, dir), { id, ok: false, error: String(error?.message ?? error) });
          } catch {}
        }
      }
    } catch (error) {
      ctx?.logger?.warn?.(`dsh-resume: 轮询异常: ${String(error)}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    scan().catch(() => {});
  }, POLL_INTERVAL_MS);
  scan().catch(() => {});

  return () => clearInterval(timer);
}

/** 仅供测试：暴露轮询间隔常量 */
export const internals = { POLL_INTERVAL_MS, HEARTBEAT_MAX_AGE_MS };
