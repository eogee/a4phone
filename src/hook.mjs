// Hook 分发器：根据 hook_event_name 决定处理逻辑
import { readMode } from './mode.mjs';
import { loadConfig } from './config.mjs';
import { systemNotify } from './notify.mjs';
import { handleStop } from './stop.mjs';
import { handleAskUserQuestion } from './asku.mjs';
import { handlePermissionRequest } from './permission.mjs';

// 根据 agent 标识返回显示名称
export function agentName(agent) {
  if (agent === 'codex') return 'Codex';
  if (agent === 'zcode') return 'ZCode';
  if (agent === 'qoder') return 'Qoder';
  if (agent === 'workbuddy') return 'WorkBuddy';
  return 'Claude Code';
}

// WorkBuddy hook 的宿主超时为 60s，超时脚本被直接终止。等待手机作答的外出模式
// 若与该上限同刻，答案还没写回 hook 输出就被杀，手机作答静默失效。
// 因此对 WorkBuddy 把等待上限收窄到 45s，留出写回与传输的余量。
export const WORKBUDDY_HOOK_TIMEOUT_MS = 60 * 1000;
const WORKBUDDY_SAFE_WAIT_MS = WORKBUDDY_HOOK_TIMEOUT_MS - 15 * 1000;

// 计算本次 hook 可用的等待上限（秒）。仅 WorkBuddy 受限，其余宿主沿用配置值。
export function resolveWaitSeconds(agent, config) {
  const configured = config?.timeout ?? 60;
  if (agent !== 'workbuddy') return configured;
  return Math.max(15, Math.min(configured, Math.floor(WORKBUDDY_SAFE_WAIT_MS / 1000)));
}

// 返回 hook 输出对象，或 null（null = 不干预，走终端默认流程）
export async function dispatchHook(input, agent) {
  const event = input.hook_event_name;
  const isOut = readMode() === 'out';
  const name = agentName(agent);
  // 宿主 hook 超时约束下的作答等待上限（仅 WorkBuddy 与配置值不同时生效）
  const waitSeconds = resolveWaitSeconds(agent, loadConfig());

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
      return handleAskUserQuestion(input, name, agent, waitSeconds);
    }
  }

  if (event === 'PermissionRequest') {
    // ZCode 对 AskUserQuestion 会同时触发 PreToolUse 和 PermissionRequest 两次 hook；
    // 提问提醒已由 PreToolUse 分支负责，这里跳过桌面弹窗，避免重复通知和误导性文案。
    if (input.tool_name !== 'AskUserQuestion') {
      await systemNotify(name, '有权限请求需要处理');
    }
    if (!isOut) return null; // 终端优先：不阻塞
    return handlePermissionRequest(input, name, waitSeconds);
  }

  return null;
}
