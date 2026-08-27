// dsh-hook — DSH hook 插件（手机交互版）
//
// 监听 DSH 会话事件流与工具/审批管线，实现三个 hook 功能（每个均有
// 本地 JSONL 日志 + 可选手机远程交互两种形态）：
//   1. task-complete       任务完成（turn/end 且 reason.kind === 'completed'）
//   2. question-asked      ask_user_question 工具调用（tools/execute 拦截）
//   3. permission-request  approval/request 审批请求（approval/request 拦截）
//
// 手机交互复用 a4phone 的 ntfy 逻辑（lib/phone/）：外出模式（out）时
// 提问/审批推送到手机点选作答，终端优先（home）时走 DSH 原生交互。
// 配置与话题复用 ~/.a4phone/config.json 与 ~/.a4phone/mode.json。
//
// 事件参考（DSH SessionEventMap / Cordis Events）：
//   - turn/end          { turn, reason: { kind: 'completed'|... } }
//   - assistant/message { turn, step, message: AssistantMessage }
//   - tools/execute     (exec, next) => ToolExecutionResult     [waterfall]
//   - approval/request  (req, next) => ApprovalOutcome          [waterfall]

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { A4P_DIR } from '../../src/paths.mjs';
import { saveLastSession } from '../../src/config.mjs';
import {
  handleTaskComplete,
  handleAskUserQuestion,
  handleApprovalRequest,
  rememberAssistantOutput,
} from './phone-hooks.mjs';
import { startResumeService, isResumeInflight } from './resume-service.mjs';

const name = 'dsh-hook';

// 监听 tools/execute 与 approval/request 需要注入这两个服务；
// session/event 直接 ctx.on 即可（与 dsh-session-telemetry 一致）。
// agents 供续聊服务解析目标会话（ctx.agents.get / roots）。
// workspaceRegistry / sessionPersistence 供“孤儿会话自愈”（临时性外部兜底）按 cwd 归组。
const inject = ['tools', 'approval', 'agents', 'workspaceRegistry', 'sessionPersistence'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 事件名到日志文件名的映射，便于按 hook 分类检索 */
const HOOK_LOG_FILE = {
  'task-complete': 'task-complete.jsonl',
  'permission-request': 'permission-request.jsonl',
  'question-asked': 'question-asked.jsonl',
};

/**
 * 记录一条 hook 事件到 JSONL 日志（并同步输出到 stderr 便于进程日志排查）。
 * @param ctx 插件上下文（用于取 logger）
 * @param logDir 日志目录
 * @param hook hook 类型
 * @param payload 事件负载（已含 sessionId 等）
 */
function record(ctx, logDir, hook, payload) {
  const entry = {
    time: new Date().toISOString(),
    hook,
    ...payload,
  };
  const line = JSON.stringify(entry);
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, HOOK_LOG_FILE[hook] ?? 'hooks.jsonl'), line + '\n');
  } catch (error) {
    ctx.logger.warn(`dsh-hook: 写入日志失败: ${String(error)}`);
  }
  process.stderr.write(`[dsh-hook] ${line}\n`);
}

/**
 * 孤儿会话自愈（临时性外部兜底方案）：把“已持久化但未计入任何 workspace 项目”的会话，
 * 按其 header.cwd 归入对应项目（必要时自动新建 workspace 记录）。
 *
 * 【定位：临时方案，非根因修复】
 * 根因是 DSH 核心 workspace 注册表的记账缺口：首次启动时用 header 归组历史目录，
 * 此后产生的会话（旧版 TUI、headless、部分启动入口等）只写会话日志、不主动记账，
 * 于是永久落在“未分组”。DSH 官方已将此列为已知待办
 * （@deepseek-ai/dsh-workspace README 的 "Known Limitations and Deferred Work"）。
 *
 * 本方案由 a4phone 在 DSH 插件中提供，作为 DSH 官方修复该 bug 之前的过渡措施：
 * 在每次启动时把缺口补上（幂等，只处理未记账的会话；失败只记日志不影响启动）。
 *
 * 【退出策略】
 * 一旦 DSH 官方修复了 workspace 记账（让所有会话在产生时即被正确归组），
 * 本模块应被评估移除——它属于与 a4phone 核心功能无关的冗余设计，
 * 不应长期留在代码中。请见 README 中 "### 待办：DSH workspace 记账归组缺陷" 一节。
 *
 * @param ctx cordis 插件上下文
 */
async function healUngroupedSessions(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const persistence = ctx.get('sessionPersistence');
  if (registry === undefined || persistence === undefined) return;
  let headers;
  try {
    headers = await persistence.list();
  } catch (error) {
    ctx.logger.warn(`dsh-hook: 会话自愈读取持久化列表失败: ${String(error)}`);
    return;
  }
  const accounted = new Set();
  for (const workspace of registry.list()) {
    for (const id of workspace.sessionIds) accounted.add(id);
  }
  for (const header of headers) {
    if (header.cwd === undefined || accounted.has(header.id)) continue;
    try {
      const workspace = await registry.resolveByPath(header.cwd) ?? await registry.create(header.cwd);
      await workspace.attachSession(header.id);
      accounted.add(header.id);
      ctx.logger.info(`dsh-hook: 已把未分组会话 ${header.id} 归入项目 ${workspace.title}`);
    } catch (error) {
      ctx.logger.warn(`dsh-hook: 会话 ${header.id} 归位失败，保持未分组: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 插件入口：注册三个 hook 的事件监听（日志 + 手机交互）。
 * @param ctx cordis 插件上下文
 * @param config 插件配置 { logDir?, taskComplete?, permissionRequest?, questionAsked?, phone?, healWorkspaces? }
 */
function apply(ctx, config = {}) {
  // 默认日志目录移到 ~/.a4phone/dsh-logs（a4phone 状态目录），不再写插件目录
  const logDir = config.logDir ?? path.join(A4P_DIR, 'dsh-logs');
  const enableTaskComplete = config.taskComplete !== false;
  const enablePermissionRequest = config.permissionRequest !== false;
  const enableQuestionAsked = config.questionAsked !== false;
  // phone: false 可整体关闭手机交互（保留日志记录），默认开启
  const phoneEnabled = config.phone !== false;
  // resume: false 可关闭 DSH 会话续聊服务（默认开启）
  const enableResume = config.resume !== false;

  // ── 会话事件流：任务完成 + 问题询问日志 + AI 最后输出缓存 ─────────────
  ctx.on('session/event', (session, event) => {
    const { type, data } = event;

    // 缓存 AI 最后输出（assistant 文本），供 task-complete 推送
    if (type === 'assistant/message') {
      rememberAssistantOutput(session.id, data?.message);
      return;
    }

    // Hook 1: 任务完成
    if (type === 'turn/end' && data?.reason?.kind === 'completed') {
      // 记录最近会话（仅顶层会话，不含 subagent），供续聊（a4p resume / a4p listen）使用
      if (enableResume && !session.header?.parentSession) {
        saveLastSession({
          session_id: session.id,
          cwd: session.header?.cwd || '未知目录',
          agent: 'DSH',
          turn: data.turn,
        });
      }
      if (enableTaskComplete) {
        record(ctx, logDir, 'task-complete', {
          sessionId: session.id,
          turn: data.turn,
          reasonKind: data.reason.kind,
        });
        // 仅顶层会话推送通知（P3-2：subagent 轮次完成也会触发 turn/end，
        // 若一并推送会刷屏；日志仍全量记录便于排查）
        if (phoneEnabled && !isResumeInflight(session.id) && !session.header?.parentSession) {
          handleTaskComplete(session.id, { turn: data.turn }).catch((error) =>
            ctx.logger.warn(`dsh-hook: 任务完成推送失败: ${String(error)}`)
          );
        }
      }
    }

    // Hook 2 日志: 问题询问（工具被调用时）
    if (enableQuestionAsked && type === 'tool/call' && data.name === 'ask_user_question') {
      let questions = null;
      try {
        questions = JSON.parse(data.arguments);
      } catch {
        questions = { raw: data.arguments };
      }
      record(ctx, logDir, 'question-asked', {
        sessionId: session.id,
        turn: data.turn,
        step: data.step,
        callId: data.callId,
        questions,
      });
    }

    // Hook 3 日志: 权限请求（audit 事件）
    if (enablePermissionRequest && type === 'approval/asked') {
      record(ctx, logDir, 'permission-request', {
        sessionId: session.id,
        approvalId: data.id,
        toolName: data.toolName,
        callId: data.callId ?? null,
        reason: data.reason ?? null,
      });
    }
    if (enablePermissionRequest && type === 'approval/decided') {
      record(ctx, logDir, 'permission-request', {
        sessionId: session.id,
        approvalId: data.id,
        outcome: data.outcome,
      });
    }
  });

  // ── Hook 2 拦截: ask_user_question → 手机点选/文字作答 ─────────────────
  // tools/execute 是 around-dispatch waterfall：返回自定义结果即替换原生提问，
  // 返回 null / 调用 next() 则放行原生交互。
  if (enableQuestionAsked && phoneEnabled) {
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'ask_user_question') return next();
      try {
        const phoneAnswers = await handleAskUserQuestion(exec);
        if (!phoneAnswers) return next();
        // 构造 ask_user_question 的规范输出契约 { answers: [...] }
        return {
          isError: false,
          value: phoneAnswers,
          content: [{ type: 'text', text: JSON.stringify(phoneAnswers) }],
        };
      } catch (error) {
        ctx.logger.warn(`dsh-hook: 手机提问处理失败，回退原生: ${String(error)}`);
        return next();
      }
    });
  }

  // ── Hook 3 拦截: approval/request → 手机 Approve/Deny ──────────────────
  // approval/request 是 waterfall：返回 outcome 即替代默认审批链，
  // 返回 null / 调用 next() 则走原生审批（当前会话策略为 ask 时生效）。
  if (enablePermissionRequest && phoneEnabled) {
    ctx.on('approval/request', async (req, next) => {
      try {
        const outcome = await handleApprovalRequest(req);
        if (!outcome) return next();
        return outcome;
      } catch (error) {
        ctx.logger.warn(`dsh-hook: 手机审批处理失败，回退原生: ${String(error)}`);
        return next();
      }
    });
  }

  // ── 远程续聊服务：手机消息（经 a4p 写入文件队列）→ followup 注入会话 ─────
  // 与桌面端共享同一个 live 会话：手机文字会以 user/message 出现在桌面会话中，
  // AI 回复同样写入会话（桌面实时可见），并经 a4p 推回手机。
  const stopResume = enableResume ? startResumeService(ctx) : () => {};

  // ── 孤儿会话自愈（临时性外部兜底：待 DSH 官方修复记账后移除）──────────
  // 等待 loader 就绪后，把已持久化但未记账的会话按 cwd 归入项目；
  // 幂等、只补缺口，可经 config.healWorkspaces: false 关闭。
  if (config.healWorkspaces !== false) {
    const loader = ctx.get('loader');
    const ready = loader?.await === undefined ? Promise.resolve() : loader.await();
    void ready
      .then(() => healUngroupedSessions(ctx))
      .catch((error) => ctx.logger.warn(`dsh-hook: 孤儿会话自愈失败: ${String(error)}`));
  }

  ctx.logger.info('dsh-hook: 已挂载三个 hook（task-complete / permission-request / question-asked）与续聊服务');

  // 返回卸载函数：插件卸载（HMR / dsh web 退出）时停止轮询
  return () => {
    stopResume();
  };
}

export { apply, inject, name };
