// Hook 分发器：根据 hook_event_name 决定处理逻辑
import { readMode } from './mode.mjs';
import { systemNotify } from './notify.mjs';
import { handleStop } from './stop.mjs';
import { handleAskUserQuestion } from './asku.mjs';
import { handlePermissionRequest } from './permission.mjs';

// 根据 agent 标识返回显示名称
export function agentName(agent) {
  if (agent === 'codex') return 'Codex';
  if (agent === 'zcode') return 'ZCode';
  return 'Claude Code';
}

// 返回 hook 输出对象，或 null（null = 不干预，走终端默认流程）
export async function dispatchHook(input, agent) {
  const event = input.hook_event_name;
  const isOut = readMode() === 'out';
  const name = agentName(agent);

  if (event === 'Stop') {
    return handleStop(input, name);
  }

  if (event === 'PreToolUse') {
    // Claude Code 的提问工具叫 AskUserQuestion；Codex 的叫 request_user_input
    const isAsk =
      input.tool_name === 'AskUserQuestion' ||
      (agent === 'codex' && input.tool_name === 'request_user_input');
    if (isAsk) {
      await systemNotify(name, '有提问需要处理');
      if (!isOut) return null; // 终端优先：不阻塞
      return handleAskUserQuestion(input, name, agent);
    }
  }

  if (event === 'PermissionRequest') {
    // ZCode 对 AskUserQuestion 会同时触发 PreToolUse 和 PermissionRequest 两次 hook；
    // 提问提醒已由 PreToolUse 分支负责，这里跳过桌面弹窗，避免重复通知和误导性文案。
    if (input.tool_name !== 'AskUserQuestion') {
      await systemNotify(name, '有权限请求需要处理');
    }
    if (!isOut) return null; // 终端优先：不阻塞
    return handlePermissionRequest(input, name);
  }

  return null;
}
