// DSH 续聊单元测试：a4p 侧文件队列协议 + 插件侧回复提取
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clipReply,
  buildResumeRequest,
  writeRequest,
  readResponse,
  clearResponse,
  clearRequest,
  waitForResponseFile,
  waitForDshReply,
  heartbeatAgeMs,
  isDshAlive,
} from '../src/dsh-resume.mjs';
import { extractReply, executeResumeTurn } from '../dsh/lib/resume-service.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-dsh-test-'));

test('clipReply：短回复原样通过，长回复截断到末尾一段', () => {
  assert.equal(clipReply('收到。'), '收到。');
  assert.equal(clipReply('  收到。\n\n  ', ), '收到。'); // 去空行
  assert.equal(clipReply(''), null);
  assert.equal(clipReply(null), null);

  const long = 'x'.repeat(5000);
  const clipped = clipReply(long);
  assert.ok(clipped.startsWith('...（输出较长已截断）'));
  assert.ok(clipped.endsWith('x'.repeat(1000)), '应保留末尾 1000 字符');
});

test('buildResumeRequest：含 id/sessionId/text/ts', () => {
  const req = buildResumeRequest('继续', 'sess-1');
  assert.ok(req.id, '应生成请求 id');
  assert.equal(req.sessionId, 'sess-1');
  assert.equal(req.text, '继续');
  assert.equal(typeof req.ts, 'number');

  const req2 = buildResumeRequest('继续', null);
  assert.equal(req2.sessionId, null);
  assert.notEqual(req.id, req2.id, '两次请求 id 不应相同');
});

test('文件队列：writeRequest 原子写入、readResponse 取回、clear 清理', async () => {
  const dir = tmpDir();
  const req = buildResumeRequest('继续', 'sess-1');
  writeRequest(req, dir);

  const reqFile = path.join(dir, `req-${req.id}.json`);
  assert.ok(fs.existsSync(reqFile), '请求文件应存在');
  assert.deepEqual(JSON.parse(fs.readFileSync(reqFile, 'utf-8')), req);

  // 尚无响应
  assert.equal(readResponse(req.id, dir), null);

  // 插件写响应后 a4p 能取回（readResponse 为纯读取，文件保留，由 waitForResponseFile 负责删除）
  const resp = { id: req.id, ok: true, reply: '好的。', sessionId: 'sess-1' };
  const respFile = path.join(dir, `resp-${req.id}.json`);
  fs.writeFileSync(respFile, JSON.stringify(resp));
  assert.deepEqual(readResponse(req.id, dir), resp);
  assert.ok(fs.existsSync(respFile), '纯读取不应删除响应文件');

  // waitForResponseFile 命中后负责删除
  const got = await waitForResponseFile(req.id, 1000, 50, dir);
  assert.deepEqual(got, resp);
  assert.ok(!fs.existsSync(respFile), 'waitForResponseFile 取回后应清理响应文件');

  // 主动清理请求文件
  clearRequest(req.id, dir);
  assert.ok(!fs.existsSync(reqFile));
  clearResponse('nonexistent', dir); // 不存在不报错
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waitForResponseFile：等待响应出现并返回，超时返回 null', async () => {
  const dir = tmpDir();
  const id = 'req-abc';
  const resp = { id, ok: true, reply: '完成。' };

  // 300ms 后写入响应
  setTimeout(() => {
    fs.writeFileSync(path.join(dir, `resp-${id}.json`), JSON.stringify(resp));
  }, 300);

  const got = await waitForResponseFile(id, 3000, 50, dir);
  assert.deepEqual(got, resp);
  assert.ok(!fs.existsSync(path.join(dir, `resp-${id}.json`)), '取回后响应文件应被清理');

  // 超时：无响应 → null
  const timedOut = await waitForResponseFile('req-nope', 200, 50, dir);
  assert.equal(timedOut, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waitForDshReply：插件中途死亡（心跳丢失）快速失败返回 {died:true}，不再干等超时', async () => {
  const dir = tmpDir();
  const id = 'req-heartbeat';
  let alive = true;
  // 心跳 1.2s 后丢失，heartbeatCheckMs=300ms
  setTimeout(() => { alive = false; }, 1200);
  const started = Date.now();
  const out = await waitForDshReply(id, 10000, {
    isAlive: () => alive,
    heartbeatCheckMs: 300,
    pollMs: 50,
    dir,
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(out, { died: true }, '心跳丢失应返回 died 标记');
  assert.ok(elapsed < 5000, `应在心跳丢失后快速失败（实际 ${elapsed}ms），而非干等超时`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waitForDshReply：心跳存活时正常等待响应/超时', async () => {
  const dir = tmpDir();
  const id = 'req-alive';
  const resp = { id, ok: true, reply: '正常回复。' };
  setTimeout(() => {
    fs.writeFileSync(path.join(dir, `resp-${id}.json`), JSON.stringify(resp));
  }, 200);
  const got = await waitForDshReply(id, 3000, { isAlive: () => true, heartbeatCheckMs: 300, pollMs: 50, dir });
  assert.deepEqual(got, resp, '心跳正常时按原逻辑等待响应');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('心跳：新鲜心跳判定存活，过期/缺失判定死亡', () => {
  const dir = tmpDir();
  const hb = path.join(dir, 'heartbeat.json');

  assert.equal(isDshAlive(1000, hb), false, '无心跳文件 → 不存活');

  fs.writeFileSync(hb, JSON.stringify({ alive: true, ts: Date.now() }));
  assert.equal(isDshAlive(1000, hb), true, '新鲜心跳 → 存活');
  assert.ok(heartbeatAgeMs(hb) <= 1000);

  fs.writeFileSync(hb, JSON.stringify({ alive: true, ts: Date.now() - 60_000 }));
  assert.equal(isDshAlive(1000, hb), false, '过期心跳 → 不存活');

  fs.writeFileSync(hb, '{bad json');
  assert.equal(heartbeatAgeMs(hb), Infinity, '损坏心跳 → Infinity');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractReply（插件侧）：只统计 boundary 之后的事件，取最后一条 assistant 文本', () => {
  const ev = (seq, type, data) => ({ seq, type, data });
  const events = [
    // boundary 之前的历史（应被忽略）
    ev(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '旧回复' }] } }),
    // 续聊轮次
    ev(2, 'user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '继续' }] }),
    ev(3, 'turn/start', { turn: 2 }),
    ev(4, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第一段' }] } }),
    ev(5, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二段' }, { type: 'text', text: '！' }] } }),
    ev(6, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];
  const { reply, reasonKind, turn } = extractReply(events, 2);
  assert.equal(reply, '第二段！', '应取 boundary 之后最后一条非空 assistant 文本');
  assert.equal(reasonKind, 'completed');
  assert.equal(turn, 2);
});

test('extractReply：轮次失败时 reasonKind 为 error 且无回复', () => {
  const ev = (seq, type, data) => ({ seq, type, data });
  const events = [
    ev(0, 'user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '继续' }] }),
    ev(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_MODEL' } } }),
  ];
  const out = extractReply(events, 0);
  assert.equal(out.reasonKind, 'error');
  assert.equal(out.reply, null);
});

test('extractReply：无新事件时回复为空', () => {
  assert.deepEqual(extractReply([], 0), { reply: null, reasonKind: null, turn: null });
});

// ── executeResumeTurn：模拟 agent 验证 followup 注入 → whenIdle → 提取回复 ──

/** 构造一个模拟 DSH agent：followup 记录消息，whenIdle 追加一轮回复事件 */
function fakeAgent({ replyBlocks, reasonKind = 'completed', whenIdleError = null, history = [] }) {
  const events = [...history];
  const received = [];
  const agent = {
    id: 'sess-1',
    session: {
      get seq() { return events.length; },
      get events() { return events; },
    },
    followup(msg) {
      received.push(msg);
      events.push({ seq: events.length, type: 'user/message', data: { id: msg.id, role: msg.role, content: msg.content } });
    },
    async whenIdle() {
      if (whenIdleError) throw new Error(whenIdleError);
      const turn = events.filter((e) => e.type === 'turn/end').length + 1;
      for (const blocks of replyBlocks) {
        events.push({ seq: events.length, type: 'assistant/message', data: { turn, step: 1, message: { content: blocks } } });
      }
      events.push({ seq: events.length, type: 'turn/end', data: { turn, reason: { kind: reasonKind } } });
    },
  };
  return { agent, events, received };
}

test('executeResumeTurn：followup 注入 user 消息并取回最后一条 assistant 文本', async () => {
  const { agent, events, received } = fakeAgent({
    replyBlocks: [
      [{ type: 'text', text: '（工具调用段落）' }],
      [{ type: 'text', text: '最终回复。' }],
    ],
  });
  const out = await executeResumeTurn(agent, '继续');
  assert.equal(out.failed, false);
  assert.equal(out.reply, '最终回复。', '应取最后一条非空 assistant 文本');
  assert.equal(out.reasonKind, 'completed');
  assert.equal(out.turn, 1);
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.error, null);

  // 注入的消息结构：普通用户消息（与 createUserMessage 等价）
  assert.equal(received.length, 1);
  assert.equal(received[0].role, 'user');
  assert.deepEqual(received[0].content, [{ type: 'text', text: '继续' }]);
  assert.deepEqual(received[0].source, { kind: 'user' });
  assert.ok(received[0].id, '应带消息 id');

  // 会话日志：user/message 先于 assistant/message（桌面端可见的顺序）
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('user/message') < types.indexOf('assistant/message'));
});

test('executeResumeTurn：轮次失败（error）标记 failed 并给出原因', async () => {
  const { agent } = fakeAgent({
    replyBlocks: [],
    reasonKind: 'error',
  });
  const out = await executeResumeTurn(agent, '继续');
  assert.equal(out.failed, true);
  assert.equal(out.reply, null);
  assert.ok(out.error.includes('error'), '应包含失败状态');
});

test('executeResumeTurn：whenIdle 抛异常时返回错误而非上抛', async () => {
  const { agent } = fakeAgent({ replyBlocks: [], whenIdleError: 'session disposed' });
  const out = await executeResumeTurn(agent, '继续');
  assert.equal(out.failed, true);
  assert.ok(out.error.includes('session disposed'));
});

test('executeResumeTurn：只提取本轮回复，历史 assistant 文本不被误取', async () => {
  const history = [
    { seq: 0, type: 'user/message', data: { id: 'old', role: 'user', content: [{ type: 'text', text: '旧问题' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: '旧回复' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  const { agent } = fakeAgent({ history, replyBlocks: [[{ type: 'text', text: '新回复' }]] });
  const out = await executeResumeTurn(agent, '继续');
  assert.equal(out.reply, '新回复');
  assert.equal(out.turn, 2, '历史已有第 0 轮，本轮应为第 2 轮');
});
