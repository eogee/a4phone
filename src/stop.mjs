// Stop 事件：任务完成 → 系统通知 + 手机推送
import { loadConfig } from './config.mjs';
import { sendNotification } from './ntfy.mjs';
import { systemNotify } from './notify.mjs';

export async function handleStop(input, agentName) {
  const config = loadConfig();
  const cwd = input.cwd || '未知目录';
  const session = input.session_id ? input.session_id.slice(0, 8) : '—';
  const details = `任务已完成\n目录: ${cwd}\n会话: ${session}`;
  await systemNotify(agentName, '任务已完成');
  if (config.topic) {
    await sendNotification({
      ...config,
      title: agentName,
      message: details,
    });
  }
  return null; // Stop Hook 无需输出
}
