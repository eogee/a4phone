// Hook 分发器：根据 hook_event_name 决定处理逻辑
import { readMode } from './mode.mjs';
import { systemNotify } from './notify.mjs';
import { handleStop } from './stop.mjs';
import { handleAskUserQuestion } from './asku.mjs';
import { handlePermissionRequest } from './permission.mjs';

// 返回 hook 输出对象，或 null（null = 不干预，走终端默认流程）
export async function dispatchHook(input) {
  const event = input.hook_event_name;
  const isOut = readMode() === 'out';

  if (event === 'Stop') {
    return handleStop(input);
  }

  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    await systemNotify('Claude Code', '有提问需要处理');
    if (!isOut) return null; // 终端优先：不阻塞
    return handleAskUserQuestion(input);
  }

  if (event === 'PermissionRequest') {
    await systemNotify('Claude Code', '有权限请求需要处理');
    if (!isOut) return null; // 终端优先：不阻塞
    return handlePermissionRequest(input);
  }

  return null;
}
