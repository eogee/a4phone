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
import {
  handleTaskComplete,
  handleAskUserQuestion,
  handleApprovalRequest,
  rememberAssistantOutput,
} from './phone-hooks.mjs';

const name = 'dsh-hook';

// 监听 tools/execute 与 approval/request 需要注入这两个服务；
// session/event 直接 ctx.on 即可（与 dsh-session-telemetry 一致）。
const inject = ['tools', 'approval'];

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
 * 插件入口：注册三个 hook 的事件监听（日志 + 手机交互）。
 * @param ctx cordis 插件上下文
 * @param config 插件配置 { logDir?, taskComplete?, permissionRequest?, questionAsked?, phone? }
 */
function apply(ctx, config = {}) {
  // 默认日志目录移到 ~/.a4phone/dsh-logs（a4phone 状态目录），不再写插件目录
  const logDir = config.logDir ?? path.join(A4P_DIR, 'dsh-logs');
  const enableTaskComplete = config.taskComplete !== false;
  const enablePermissionRequest = config.permissionRequest !== false;
  const enableQuestionAsked = config.questionAsked !== false;
  // phone: false 可整体关闭手机交互（保留日志记录），默认开启
  const phoneEnabled = config.phone !== false;

  // ── 会话事件流：任务完成 + 问题询问日志 + AI 最后输出缓存 ─────────────
  ctx.on('session/event', (session, event) => {
    const { type, data } = event;

    // 缓存 AI 最后输出（assistant 文本），供 task-complete 推送
    if (type === 'assistant/message') {
      rememberAssistantOutput(session.id, data?.message);
      return;
    }

    // Hook 1: 任务完成
    if (enableTaskComplete && type === 'turn/end' && data?.reason?.kind === 'completed') {
      record(ctx, logDir, 'task-complete', {
        sessionId: session.id,
        turn: data.turn,
        reasonKind: data.reason.kind,
      });
      if (phoneEnabled) {
        handleTaskComplete(session.id, { turn: data.turn }).catch((error) =>
          ctx.logger.warn(`dsh-hook: 任务完成推送失败: ${String(error)}`)
        );
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

  ctx.logger.info('dsh-hook: 已挂载三个 hook（task-complete / permission-request / question-asked）');
}

export { apply, inject, name };
