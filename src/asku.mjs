// AskUserQuestion 事件（外出模式）：推送提问到手机，手机点选后注入答案
import crypto from 'crypto';
import { loadConfig } from './config.mjs';
import { sendNotification, waitForResponse } from './ntfy.mjs';

// 把手机答案构造成 hook 输出
//   Claude Code：updatedInput.answers 改写工具输入（工具自带跳过用户交互的实现）
//   Codex：提问工具是 request_user_input，其 handler 忽略输入里的 answers，只能阻断该工具调用、
//          并把答案写进 permissionDecisionReason，让模型看到"用户已作答"后直接采用答案继续
export function buildAskOutput(agent, questions, answers) {
  if (agent === 'codex') {
    const lines = Object.entries(answers).map(([q, a], i) => `${i + 1}. ${q} → ${a}`);
    const reason =
      '用户在手机端回答了以下提问，请直接采用这些答案继续当前任务，不要再调用 request_user_input 工具：\n' +
      lines.join('\n');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  };
}

export async function handleAskUserQuestion(input, agentName, agent = 'claude') {
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
    lines.push(''); // 留空行分隔
    lines.push(`（也可直接向话题 ${config.topic}-response 发送文字作答）`);
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

  return buildAskOutput(agent, questions, answers);
}
