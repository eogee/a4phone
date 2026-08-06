// AskUserQuestion 事件（外出模式）：推送提问到手机，手机点选后注入答案
import crypto from 'crypto';
import { loadConfig } from './config.mjs';
import { sendNotification, waitForResponse } from './ntfy.mjs';

export async function handleAskUserQuestion(input, agentName) {
  const config = loadConfig();
  const questions = input.tool_input?.questions || [];
  if (!config.topic || !questions.length) return null;

  const answers = {};
  for (const q of questions) {
    const options = q.options || [];
    if (!options.length) continue;
    const requestId = crypto.randomUUID();
    const actions = options.map((o) => ({
      action: 'http',
      label: o.label,
      url: `${config.server}/${config.topic}-response`,
      method: 'POST',
      clear: false,
      body: JSON.stringify({ requestId, answer: o.label }),
    }));
    const lines = [q.question];
    options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
    const sent = await sendNotification({
      ...config,
      title: `${agentName}: ${q.header || 'Question'}`,
      message: lines.join('\n'),
      actions,
    });
    if (!sent) return null; // 推送失败 → 回退终端
    const resp = await waitForResponse({ ...config, requestId, timeout: config.timeout * 1000 });
    if (!resp?.answer) return null; // 手机超时 → 回退终端
    answers[q.question] = resp.answer;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  };
}
