// phone-hooks.mjs — dsh-hook 的手机交互实现
//
// 将 a4phone（Claude Code/Codex 手机远程交互包）的 ntfy 交互逻辑适配到 DSH：
//   1. task-complete       任务完成 → 手机推送（含 AI 最后输出）
//   2. question-asked      ask_user_question 工具调用 → 手机点选/文字作答
//   3. permission-request  approval/request → 手机 Approve/Deny/Always
//
// 适配说明（与 a4phone 的差异）：
//   - a4phone 走 Claude Code/Codex 的 hook 协议（hook_event_name、stdin JSON）；
//     DSH 没有该协议，本模块改为监听 DSH 的 Cordis 事件（session/event、
//     tools/execute、approval/request）。
//   - 配置/模式/推送复用 a4phone 的 ~/.a4phone/config.json 与 mode.json
//     （手机端无需重新订阅，同一话题即可收到 DSH 推送）。
//   - 外出模式（out）时手机优先；终端优先（home）时走 DSH 原生交互，不阻塞。
//
// 整合到 a4phone 后，配置/模式/推送直接复用 a4phone 的 src/ 模块（零拷贝），
// 不再保留独立的 lib/phone/ 副本。

import crypto from 'crypto';
import { loadConfig } from '../../src/config.mjs';
import { readMode } from '../../src/mode.mjs';
import { sendNotification, waitForResponse } from '../../src/ntfy.mjs';
import { systemNotify } from '../../src/notify.mjs';

/** 单条手机交互的最大等待时间（秒），取自 a4phone 配置的 timeout。 */

// 记录最近一次任务完成的 AI 最后输出（供 task-complete 推送；session 级缓存，避免跨会话串扰）
const lastAssistantOutput = new Map();

/**
 * 缓存某会话最近的 AI 文本输出（由 session/event 的 assistant/message 驱动）。
 * @param {string} sessionId
 * @param {import('@deepseek-ai/dsh-session').AssistantMessage} message
 */
export function rememberAssistantOutput(sessionId, message) {
  if (!message?.content) return;
  const texts = message.content
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text);
  if (texts.length) lastAssistantOutput.set(sessionId, texts.join('\n'));
}

/** 判断手机交互是否启用：外出模式 + 已配置话题。 */
function phoneActive() {
  const cfg = loadConfig();
  return readMode() === 'out' && Boolean(cfg.topic);
}

/**
 * Hook 1: 任务完成 → 系统通知 + 手机推送（含 AI 最后输出）。
 * 与 a4phone 的 handleStop 对齐：Stop 事件 → 通知 + 推送。
 * @param {string} sessionId
 * @param {object} extra 附加信息（如 turn 号）
 */
export async function handleTaskComplete(sessionId, extra = {}) {
  const cfg = loadConfig();
  const shortId = sessionId ? sessionId.slice(0, 8) : '—';
  const details = `任务已完成\n会话: ${shortId}${extra.turn != null ? `\n轮次: ${extra.turn}` : ''}`;

  await systemNotify('DSH', '任务已完成');

  if (cfg.topic) {
    const lastOutput = lastAssistantOutput.get(sessionId);
    const message = lastOutput ? `${details}\n\nAI 最后输出：\n${lastOutput}` : details;
    await sendNotification({ ...cfg, title: 'DSH', message });
  }
}

/**
 * Hook 2: 问题询问 → 拦截 ask_user_question 工具调用，推送手机点选/文字作答。
 * 复用 a4phone 的 buildAskOutput 思路：DSH 的 ask_user_question 输出契约是
 * { answers: [{ id, selected, custom? }] }，因此直接返回该结构即可。
 * 手机超时/推送失败/终端模式 → 返回 null 表示放行 DSH 原生提问。
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @returns {Promise<{answers: Array<object>} | null>}
 */
export async function handleAskUserQuestion(exec) {
  if (!phoneActive()) return null;
  const cfg = loadConfig();
  const args = exec.arguments || {};
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (!questions.length) return null;

  const answers = [];
  for (const q of questions) {
    const options = Array.isArray(q.options) ? q.options : [];
    // 无选项的提问无法手机作答，直接跳过（与 asku.mjs 一致，避免推送后干等超时回退）
    if (!options.length) continue;
    const requestId = crypto.randomUUID();
    // ntfy 最多允许 3 个 action 按钮（超过返回 HTTP 400，推送失败）。
    // 选项 ≤3 → 按钮点选；>3 → 降级为文本编号列表 + 文字作答（waitForResponse 支持自由文本）。
    const useActions = options.length > 0 && options.length <= 3;
    const actions = useActions
      ? options.map((o) => ({
          action: 'http',
          label: o.label,
          url: `${cfg.server}/${cfg.topic}-response`,
          method: 'POST',
          clear: false,
          body: JSON.stringify({ requestId, answer: o.label }),
        }))
      : undefined;
    const lines = [q.question || 'Question'];
    options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
    lines.push('');
    lines.push(
      useActions
        ? `（也可直接向话题 ${cfg.topic}-response 发送文字作答）`
        : `（选项较多，请回复编号如「3」，或直接向话题 ${cfg.topic}-response 发送文字作答）`
    );
    // 浏览器兜底：未订阅响应话题的用户可打开网页版直接回复（自由作答/编号回复都需要）
    lines.push(`（如未订阅响应话题，可浏览器打开 ${cfg.server}/${cfg.topic}-response 直接回复）`);
    if (!useActions && options.length > 3) {
      process.stderr.write(`[dsh-hook] 选项 ${options.length} 个超 ntfy 按钮上限(3)，已降级为文字作答\n`);
    }

    const sent = await sendNotification({
      ...cfg,
      title: `DSH: ${q.header || 'Question'}`,
      message: lines.join('\n'),
      ...(actions ? { actions } : {}),
    });
    if (!sent) return null; // 推送失败 → 回退终端

    const resp = await waitForResponse({ ...cfg, requestId, timeout: cfg.timeout * 1000 });
    if (!resp?.answer) return null; // 手机超时 → 回退终端

    // 降级场景下手机可能回编号（如「3」），映射回选项 label；
    // 按钮场景 answer 本就是 label；自由文本则原样作为答案。
    let answer = resp.answer;
    if (!useActions) {
      const idx = Number(String(answer).trim());
      if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
        answer = options[idx - 1].label;
      }
    }

    answers.push({
      id: q.id,
      selected: [answer],
      ...(resp.custom ? { custom: resp.custom } : {}),
    });
  }
  return { answers };
}

/**
 * Hook 3: 权限请求 → 拦截 approval/request，推送手机 Approve/Deny/Always。
 * 复用 a4phone 的 handlePermissionRequest 思路；DSH 的 ApprovalOutcome 契约是
 * 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'，手机点选映射为
 * allowed-once / rejected。手机超时/推送失败/终端模式 → 返回 null 放行原链。
 * @param {import('@deepseek-ai/dsh-user-approval').ApprovalRequest} req
 * @returns {Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome | null>}
 */
export async function handleApprovalRequest(req) {
  if (!phoneActive()) return null;
  const cfg = loadConfig();

  const toolName = req.toolName || 'Unknown';
  const message = req.reason || `工具 ${toolName} 请求权限`;
  const requestId = crypto.randomUUID();
  const url = `${cfg.server}/${cfg.topic}-response`;
  const actions = [
    { action: 'http', label: 'Approve', url, method: 'POST', clear: false, body: JSON.stringify({ requestId, approved: true }) },
    { action: 'http', label: 'Deny', url, method: 'POST', clear: false, body: JSON.stringify({ requestId, approved: false }) },
  ];

  const sent = await sendNotification({ ...cfg, title: `DSH: ${toolName}`, message, actions });
  if (!sent) return null;

  const resp = await waitForResponse({ ...cfg, requestId, timeout: cfg.timeout * 1000 });
  if (!resp) return null; // 手机超时 → 回退

  return resp.approved === false ? 'rejected' : 'allowed-once';
}

export { systemNotify };
