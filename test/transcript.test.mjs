// extractLastOutput 回归测试
//   核心回归：Codex 触发 Stop 时，当前轮的 task_complete 事件比 assistant message 晚 ~1.4s 才落盘，
//   若只从 task_complete 取输出会拿到上一轮的回复。修复后应从最后一条 response_item message 取。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractLastOutput } from '../src/transcript.mjs';

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
