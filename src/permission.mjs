// PermissionRequest 事件（外出模式）：推送 Approve/Deny 到手机，点击后返回决策
import crypto from 'crypto';
import { loadConfig } from './config.mjs';
import { sendNotification, waitForResponse } from './ntfy.mjs';

const MESSAGE_MAX_LENGTH = 1000;

function formatMessage(tool_name, tool_input) {
  let message;
  if (tool_name === 'ExitPlanMode' && typeof tool_input?.plan === 'string') {
    message = tool_input.plan.trim() || '(empty plan)';
  } else {
    switch (tool_name) {
      case 'Bash':
        message = tool_input?.command ?? JSON.stringify(tool_input);
        break;
      case 'Read':
      case 'Write':
      case 'Edit':
        message = tool_input?.file_path ?? JSON.stringify(tool_input);
        break;
      default:
        message = JSON.stringify(tool_input);
        break;
    }
  }
  return message.length > MESSAGE_MAX_LENGTH ? message.slice(0, MESSAGE_MAX_LENGTH) + '...' : message;
}

export async function handlePermissionRequest(input, agentName) {
  const config = loadConfig();
  if (!config.topic) return null;

  const tool_name = input.tool_name || 'Unknown';
  const message = formatMessage(tool_name, input.tool_input);
  const requestId = crypto.randomUUID();
  const url = `${config.server}/${config.topic}-response`;
  const actions = [
    { action: 'http', label: 'Approve', url, method: 'POST', clear: false, body: JSON.stringify({ requestId, approved: true }) },
    { action: 'http', label: 'Deny', url, method: 'POST', clear: false, body: JSON.stringify({ requestId, approved: false }) },
  ];
  if (input.permission_suggestions?.length > 0) {
    actions.splice(1, 0, { action: 'http', label: 'Always Approve', url, method: 'POST', clear: false, body: JSON.stringify({ requestId, approved: true, alwaysAllow: true }) });
  }

  const sent = await sendNotification({ ...config, title: `${agentName}: ${tool_name}`, message, actions });
  if (!sent) return null;

  const isPlan = tool_name === 'ExitPlanMode';
  const timeout = (isPlan ? config.planTimeout : config.timeout) * 1000;
  const resp = await waitForResponse({ ...config, requestId, timeout });
  if (!resp) return null; // 手机超时 → 回退终端

  const decision = { behavior: resp.approved === false ? 'deny' : 'allow' };
  if (resp.alwaysAllow === true && input.permission_suggestions?.length > 0) {
    decision.updatedPermissions = input.permission_suggestions;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}
