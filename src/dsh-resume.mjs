// DSH 续聊（a4p 侧）：把手机发来的文本交给 dsh web 进程内的插件续聊，取回回复并推送手机
//
// 通信协议（文件队列，同一台机器）：
//   a4p 写  ~/.a4phone/dsh-jobs/req-<id>.json  { id, sessionId?, text, ts }
//   插件写 ~/.a4phone/dsh-jobs/resp-<id>.json  { id, ok, reply?, reasonKind?, error?, sessionId? }
//   插件每 ~/.a4phone/dsh-heartbeat.json 刷新一次心跳，a4p 据此快速判断 dsh web 是否存活
//
// 与 Claude Code / Codex 续聊的区别：
//   - 不另起进程，而是让 dsh web 进程内直接 followup 到当前 live 会话，
//     手机消息与 AI 回复都会实时出现在桌面端会话里，且无会话锁冲突
//   - 前提：dsh web 正在运行且已挂载新版 dsh-hook 插件（含续聊服务）
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DSH_JOB_DIR, DSH_HEARTBEAT } from './paths.mjs';
import { loadConfig, loadLastSession } from './config.mjs';
import { sendNotification } from './ntfy.mjs';

const POLL_INTERVAL_MS = 500; // 轮询回复文件的间隔
const MAX_REPLY = 1000; // 回推输出截断长度（与 Claude/Codex 续聊一致）
const HEARTBEAT_MAX_AGE_MS = 10_000; // 心跳超过 10 秒视为 dsh web（插件）未运行

/** 心跳新鲜度（毫秒）；读不到或解析失败返回 Infinity（视为已死） */
export function heartbeatAgeMs(filePath = DSH_HEARTBEAT) {
  try {
    const hb = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!hb || typeof hb.ts !== 'number') return Infinity;
    return Date.now() - hb.ts;
  } catch {
    return Infinity;
  }
}

/** dsh web（dsh-hook 插件）是否存活：心跳新鲜且未超龄 */
export function isDshAlive(maxAgeMs = HEARTBEAT_MAX_AGE_MS, filePath = DSH_HEARTBEAT) {
  return heartbeatAgeMs(filePath) <= maxAgeMs;
}

/** 构造一条续聊请求（纯函数，便于测试） */
export function buildResumeRequest(text, sessionId) {
  return { id: crypto.randomUUID(), sessionId: sessionId ?? null, text, ts: Date.now() };
}

/** 原子写入请求文件（临时文件 + rename，避免插件读到半个文件） */
export function writeRequest(req, dir = DSH_JOB_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.req-${req.id}.${process.pid}.tmp`);
  const dst = path.join(dir, `req-${req.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(req));
  fs.renameSync(tmp, dst);
}

/** 读取响应文件；不存在/解析失败返回 null（纯读取，删除由 waitForResponseFile 负责） */
export function readResponse(id, dir = DSH_JOB_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `resp-${id}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

/** 清理响应文件（读走后删除，避免队列堆积） */
export function clearResponse(id, dir = DSH_JOB_DIR) {
  try { fs.unlinkSync(path.join(dir, `resp-${id}.json`)); } catch {}
}

/** 清理请求文件（超时后删除，避免残留） */
export function clearRequest(id, dir = DSH_JOB_DIR) {
  try { fs.unlinkSync(path.join(dir, `req-${id}.json`)); } catch {}
}

/** 轮询响应文件直到出现或超时；命中后立即删除并返回内容 */
export async function waitForResponseFile(id, timeoutMs, pollMs = POLL_INTERVAL_MS, dir = DSH_JOB_DIR) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = readResponse(id, dir);
    if (resp) {
      clearResponse(id, dir);
      return resp;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** DSH 续聊专用轮询：等待 resp 的同时周期复查心跳，插件中途死亡时快速失败
 * （P4-2：避免 dsh web 退出后手机端干等满 resumeTimeout）。
 * 返回 { died: true } 表示心跳丢失；null 表示超时；否则为 resp 内容。 */
export async function waitForDshReply(id, timeoutMs, {
  isAlive,
  heartbeatCheckMs = 10_000,
  pollMs = POLL_INTERVAL_MS,
  dir = DSH_JOB_DIR,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastCheck = 0;
  while (Date.now() < deadline) {
    const resp = readResponse(id, dir);
    if (resp) {
      clearResponse(id, dir);
      return resp;
    }
    const now = Date.now();
    if (isAlive && now - lastCheck >= heartbeatCheckMs) {
      lastCheck = now;
      if (!isAlive()) return { died: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** 回复文本截断：去空行，取末尾一段（与 Claude/Codex 续聊的回推格式一致） */
export function clipReply(reply) {
  const clean = (reply || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  if (!clean) return null;
  return clean.length > MAX_REPLY ? '...（输出较长已截断）\n' + clean.slice(-MAX_REPLY) : clean;
}

/**
 * 执行一次 DSH 续聊：提交请求 → 轮询回复 → 推回手机。
 * @param {string} text 手机发来的续聊内容
 * @returns {Promise<{ok:boolean, reason?:string, code?:number}>}
 */
export async function runDshResume(text, { config = null, onLog = (s) => {} } = {}) {
  config = config || loadConfig();
  if (!config.topic) return { ok: false, reason: '未配置话题，请先运行 a4p setup。' };

  const textClean = (text || '').trim();
  if (!textClean) return { ok: false, reason: '续聊内容为空。' };

  // 失败反馈：把失败原因推回手机（P3-1：与 Claude/Codex 路径一致，手机端不干等无反馈）
  const pushFailure = async (message) => {
    await sendNotification({ ...config, title: 'DSH', message: `续聊失败\n\n${message}` });
  };

  if (!isDshAlive()) {
    const reason = '未检测到运行中的 DSH（dsh web 进程心跳过期）。\n请确认 dsh web 正在运行，且已挂载新版 dsh-hook 插件（可重新执行 a4p setup 挂载）。';
    await pushFailure(reason);
    return { ok: false, reason };
  }

  // 最近 DSH 会话优先指定目标；无则交给插件兜底选最近顶层会话
  const last = loadLastSession();
  const sessionId = last?.agent === 'DSH' ? last.session_id : null;
  const req = buildResumeRequest(textClean, sessionId);
  writeRequest(req);
  onLog(`DSH 续聊请求已提交${sessionId ? `（会话 ${sessionId.slice(0, 8)}）` : ''}，等待 dsh web 回复…`);

  const timeoutMs = (config.resumeTimeout ?? 1800) * 1000;
  // 轮询期间周期复查心跳：插件中途死亡立即失败（P4-2），不再干等满超时
  const resp = await waitForDshReply(req.id, timeoutMs, { isAlive: () => isDshAlive() });
  if (!resp) {
    clearRequest(req.id);
    const reason = '续聊超时：dsh web 进程未在限时内回复（请确认 dsh web 正在运行，会话未被占用）。';
    await pushFailure(reason);
    return { ok: false, reason };
  }
  if (resp.died) {
    clearRequest(req.id);
    const reason = 'dsh web 进程在续聊中途退出（心跳丢失），续聊已中断，请重新发送消息。';
    await pushFailure(reason);
    return { ok: false, reason };
  }

  let message;
  if (!resp.ok) {
    onLog(`DSH 续聊失败：${resp.error || '未知错误'}`);
    message = `续聊失败\n\n${resp.error || '未知错误'}`;
  } else {
    const reply = clipReply(resp.reply);
    if (reply) {
      onLog('DSH 续聊完成，结果已推送手机');
      message = `续聊已完成\n\n${reply}`;
    } else {
      onLog(`DSH 续聊完成（无文本输出，轮次状态 ${resp.reasonKind ?? '?'}）`);
      message = `续聊已完成（轮次状态 ${resp.reasonKind ?? '?'}，无文本输出）`;
    }
  }
  await sendNotification({ ...config, title: 'DSH', message });
  return { ok: resp.ok, code: 0 };
}
