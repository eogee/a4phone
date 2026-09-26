// Stop 事件：任务完成 → 系统通知 + 手机推送（含 AI 最后输出）+ 记录最近会话
import { loadConfig, saveLastSession } from './config.mjs';
import { sendNotification } from './ntfy.mjs';
import { systemNotify } from './notify.mjs';
import { resolveLastOutput } from './transcript.mjs';

export async function handleStop(input, agentName) {
  const config = loadConfig();
  const cwd = input.cwd || '未知目录';
  const session = input.session_id ? input.session_id.slice(0, 8) : '—';
  const details = `任务已完成\n目录: ${cwd}\n会话: ${session}`;

  // 记录最近会话，供续聊（a4p resume / a4p listen）使用
  if (input.session_id) {
    saveLastSession({ session_id: input.session_id, cwd, agent: agentName, transcript_path: input.transcript_path });
  }

  // 续聊子进程（A4P_RESUME=1）的 Stop 事件：结果已由 runResume 推回手机，此处不重复推送
  if (process.env.A4P_RESUME === '1') return null;

  await systemNotify(agentName, '任务已完成');

  if (config.topic) {
    // ZCode 在 Stop 载荷直送 last_assistant_message，其余 agent 从 transcript 文件抽取
    const lastOutput = resolveLastOutput(input);
    const message = lastOutput ? `${details}\n\nAI 最后输出：\n${lastOutput}` : details;
    await sendNotification({
      ...config,
      title: agentName,
      message,
    });
  }
  return null; // Stop Hook 无需输出
}
