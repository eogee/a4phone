// extractLastOutput / resolveLastOutput 回归测试
//   核心回归 1：Codex 触发 Stop 时，当前轮的 task_complete 事件比 assistant message 晚 ~1.4s 才落盘，
//   若只从 task_complete 取输出会拿到上一轮的回复。修复后应从最后一条 response_item message 取。
//   核心回归 2：ZCode 在 hook 触发时合成的单行伪 transcript 顶层没有 type（role 在 message.role），
//   原解析器匹配不到导致通知丢失 AI 输出；且 Stop 载荷直送 last_assistant_message，应优先使用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractLastOutput, resolveLastOutput } from '../src/transcript.mjs';

let seq = 0;

const msg = (text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer' },
});
const taskComplete = (text) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: text },
});
const claudeAssistant = (text) => JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});
// ZCode hook 触发时写入临时 transcript.jsonl 的合成行（来自 zcode.cjs formatClaudeMessageLine）
const zcodeSynthetic = (role, text) => JSON.stringify({
  message: { content: [{ text, type: 'text' }], role },
});

function writeTranscript(lines) {
  const file = path.join(os.tmpdir(), `a4p-transcript-${process.pid}-${++seq}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('Codex Stop 时 task_complete 未写入：从最后一条 assistant message 取当前输出', () => {
  // 模拟 Stop hook 触发瞬间：当前轮 message 已写入，但 task_complete 尚未落盘
  const file = writeTranscript([
    msg('上一轮：周末爬山'),
    taskComplete('上一轮：周末爬山'),
    msg('当前轮：我是 Codex'),
  ]);
  try {
    assert.equal(extractLastOutput(file), '当前轮：我是 Codex');
  } finally {
    fs.unlinkSync(file);
  }
});

test('Codex 文件稳定（含 task_complete）仍返回当前输出', () => {
  const file = writeTranscript([
    msg('上一轮：周末爬山'),
    taskComplete('上一轮：周末爬山'),
    msg('当前轮：我是 Codex'),
    taskComplete('当前轮：我是 Codex'),
  ]);
  try {
    assert.equal(extractLastOutput(file), '当前轮：我是 Codex');
  } finally {
    fs.unlinkSync(file);
  }
});

test('Claude Code assistant 消息路径不变', () => {
  const file = writeTranscript([
    claudeAssistant('第一段'),
    claudeAssistant('最后一段'),
  ]);
  try {
    assert.equal(extractLastOutput(file), '最后一段');
  } finally {
    fs.unlinkSync(file);
  }
});

test('空 transcript 或无输出时返回 null', () => {
  const file = writeTranscript([
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
  ]);
  try {
    assert.equal(extractLastOutput(file), null);
  } finally {
    fs.unlinkSync(file);
  }
});

test('ZCode 合成的单行伪 transcript（顶层无 type）能取到输出', () => {
  const file = writeTranscript([zcodeSynthetic('assistant', '我是 ZCode 的最后回复')]);
  try {
    assert.equal(extractLastOutput(file), '我是 ZCode 的最后回复');
  } finally {
    fs.unlinkSync(file);
  }
});

test('ZCode 的 user 提示行不误匹配', () => {
  // ZCode UserPromptSubmit 时写入 {"message":{...,"role":"user"}}，不应被当作 AI 输出
  const file = writeTranscript([zcodeSynthetic('user', '用户的问题')]);
  try {
    assert.equal(extractLastOutput(file), null);
  } finally {
    fs.unlinkSync(file);
  }
});

test('resolveLastOutput：ZCode 直送的 last_assistant_message 优先', () => {
  assert.equal(resolveLastOutput({ last_assistant_message: '  直送内容  ' }), '直送内容');
});

test('resolveLastOutput：直送字段缺失/为空时回退 transcript 文件', () => {
  const file = writeTranscript([claudeAssistant('来自 transcript 的输出')]);
  try {
    assert.equal(resolveLastOutput({ transcript_path: file }), '来自 transcript 的输出');
    assert.equal(resolveLastOutput({ last_assistant_message: '   ', transcript_path: file }), '来自 transcript 的输出');
  } finally {
    fs.unlinkSync(file);
  }
});

test('resolveLastOutput：直送字段同样受 1000 字符截断', () => {
  const long = '甲'.repeat(1200);
  const out = resolveLastOutput({ last_assistant_message: long });
  assert.equal(out.length, 1003);
  assert.ok(out.endsWith('...'));
});

test('resolveLastOutput：两者皆无时返回 null', () => {
  assert.equal(resolveLastOutput({}), null);
  assert.equal(resolveLastOutput(), null);
});

// ── WorkBuddy ────────────────────────────────────────────────────────
// WorkBuddy 会话文件（~/.workbuddy/projects/<slug>/<sessionId>.jsonl）的消息结构
// 与 Claude Code 三个字段全不同：顶层 type="message"（非 assistant）、role 在顶层（非 message.role）、
// 文本块 type="output_text"（非 text）。实测 5.7.6。
const wbMessage = (role, text) => JSON.stringify({
  type: 'message',
  role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});
const wbSessionMeta = JSON.stringify({
  type: 'session-meta',
  sessionId: 'sess-1',
  meta: { 'codebuddy.ai/hostKind': 'unopted' },
});

test('WorkBuddy：从 type=message + role=assistant + output_text 取最后输出', () => {
  const file = writeTranscript([
    wbSessionMeta,
    wbMessage('user', '第一条提问'),
    wbMessage('assistant', '第一轮回复'),
    wbMessage('user', '继续'),
    wbMessage('assistant', '第二轮回复（应取这条）'),
  ]);
  try {
    assert.equal(extractLastOutput(file), '第二轮回复（应取这条）');
  } finally {
    fs.unlinkSync(file);
  }
});

test('WorkBuddy：reasoning 行不影响 assistant 取值', () => {
  const file = writeTranscript([
    wbMessage('assistant', '正式回复'),
    JSON.stringify({ type: 'reasoning', content: [{ type: 'text', text: '思考过程' }] }),
  ]);
  try {
    assert.equal(extractLastOutput(file), '正式回复');
  } finally {
    fs.unlinkSync(file);
  }
});

test('WorkBuddy：Stop 直送 last_assistant_message 时优先于 transcript', () => {
  const file = writeTranscript([wbMessage('assistant', '来自 transcript 的输出')]);
  try {
    assert.equal(resolveLastOutput({ last_assistant_message: '直送输出', transcript_path: file }), '直送输出');
  } finally {
    fs.unlinkSync(file);
  }
});

test('WorkBuddy：只有 user 消息时返回 null', () => {
  const file = writeTranscript([wbSessionMeta, wbMessage('user', '你好')]);
  try {
    assert.equal(extractLastOutput(file), null);
  } finally {
    fs.unlinkSync(file);
  }
});
