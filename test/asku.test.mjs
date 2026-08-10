// buildAskOutput 单元测试：Claude Code 用 updatedInput 注入答案，
// Codex（request_user_input）因 handler 忽略输入中的 answers，改为阻断工具并把答案写进阻断原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAskOutput } from '../src/asku.mjs';

const questions = [
  { question: '周末想去哪？', options: [{ label: '爬山' }, { label: '看电影' }] },
  { question: '几点出发？', options: [{ label: '早上' }, { label: '下午' }] },
];
const answers = { '周末想去哪？': '爬山', '几点出发？': '早上' };

test('Claude Code：permissionDecision allow + updatedInput.answers 注入', () => {
  const out = buildAskOutput('claude', questions, answers);
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  });
});

test('Codex：阻断 request_user_input，答案写入 permissionDecisionReason', () => {
  const out = buildAskOutput('codex', questions, answers);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /爬山/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /周末想去哪？.*爬山/s);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /不要/);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
});
