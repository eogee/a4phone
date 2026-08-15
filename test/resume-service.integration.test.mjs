// resume-service 集成测试：真实插件扫描循环（startResumeService）+ 真实 a4p 协议函数
// 用模拟 ctx/agents 驱动，验证 req 文件 → 扫描 → followup → resp 文件的完整闭环
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startResumeService } from '../dsh/lib/resume-service.mjs';
import { buildResumeRequest, writeRequest, waitForResponseFile } from '../src/dsh-resume.mjs';

/** 模拟 agent：收到 followup 后追加一轮回复事件 */
function makeFakeAgent(id, { replyText = '回复内容', reasonKind = 'completed' } = {}) {
  const events = [];
  return {
    id,
    session: {
      get seq() { return events.length; },
      get events() { return events; },
    },
    followup(msg) {
      events.push({ seq: events.length, type: 'user/message', data: { id: msg.id, role: msg.role, content: msg.content } });
    },
    async whenIdle() {
      events.push({ seq: events.length, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: replyText }] } } });
      events.push({ seq: events.length, type: 'turn/end', data: { turn: 1, reason: { kind: reasonKind } } });
    },
  };
}

/** 模拟 cordis ctx：get('agents') 返回注册表；logger 记录告警 */
function makeFakeCtx(agents) {
  return {
    get: (name) => (name === 'agents' ? agents : undefined),
    logger: { warn: () => {}, info: () => {} },
  };
}

test('集成：真实扫描循环完成 req→resp 闭环（命中指定 sessionId）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-svc-int-'));
  const agentA = makeFakeAgent('sess-a');
  const agentB = makeFakeAgent('sess-b');
  const agents = { get: (id) => (id === 'sess-a' ? agentA : id === 'sess-b' ? agentB : undefined), roots: () => [agentA, agentB] };
  const ctx = makeFakeCtx(agents);
  const stop = startResumeService(ctx, { dir, heartbeatPath: path.join(dir, 'hb.json') });
  try {
    // a4p 侧提交请求（指定会话 sess-b）
    const req = buildResumeRequest('继续', 'sess-b');
    writeRequest(req, dir);
    const resp = await waitForResponseFile(req.id, 8000, 100, dir);
    assert.ok(resp, '应收到响应');
    assert.equal(resp.ok, true);
    assert.equal(resp.reply, '回复内容');
    assert.equal(resp.sessionId, 'sess-b');
    assert.equal(resp.reasonKind, 'completed');
    // 注入的是目标会话
    assert.ok(agentB.session.events.some((e) => e.type === 'user/message'), 'sess-b 应收到注入的消息');
    assert.ok(!agentA.session.events.some((e) => e.type === 'user/message'), 'sess-a 不应收到消息');
    // 心跳文件被刷新
    const hb = JSON.parse(fs.readFileSync(path.join(dir, 'hb.json'), 'utf-8'));
    assert.equal(hb.alive, true);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：未指定 sessionId 时兜底最近 root agent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-svc-int-'));
  const agentA = makeFakeAgent('sess-a');
  const agentB = makeFakeAgent('sess-b');
  const agents = { get: () => undefined, roots: () => [agentA, agentB] }; // 最近 root = agentB
  const ctx = makeFakeCtx(agents);
  const stop = startResumeService(ctx, { dir, heartbeatPath: path.join(dir, 'hb.json') });
  try {
    const req = buildResumeRequest('继续', null);
    writeRequest(req, dir);
    const resp = await waitForResponseFile(req.id, 8000, 100, dir);
    assert.ok(resp, '应收到响应');
    assert.equal(resp.sessionId, 'sess-b', '应兜底到最近 root agent');
    assert.equal(resp.ok, true);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：无可用会话时返回明确错误（ok=false）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-svc-int-'));
  const agents = { get: () => undefined, roots: () => [] };
  const ctx = makeFakeCtx(agents);
  const stop = startResumeService(ctx, { dir, heartbeatPath: path.join(dir, 'hb.json') });
  try {
    const req = buildResumeRequest('继续', 'sess-gone');
    writeRequest(req, dir);
    const resp = await waitForResponseFile(req.id, 8000, 100, dir);
    assert.ok(resp, '应收到响应');
    assert.equal(resp.ok, false);
    assert.ok(resp.error.includes('没有可续聊的 DSH 会话'));
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：轮次失败（error）时 ok=false 且带错误信息', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-svc-int-'));
  const agent = makeFakeAgent('sess-x', { reasonKind: 'error' });
  const agents = { get: () => agent, roots: () => [agent] };
  const ctx = makeFakeCtx(agents);
  const stop = startResumeService(ctx, { dir, heartbeatPath: path.join(dir, 'hb.json') });
  try {
    const req = buildResumeRequest('继续', 'sess-x');
    writeRequest(req, dir);
    const resp = await waitForResponseFile(req.id, 8000, 100, dir);
    assert.ok(resp, '应收到响应');
    assert.equal(resp.ok, false);
    assert.ok(resp.error.includes('error'), '错误应包含轮次状态');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：损坏的请求文件（BOM）返回格式错误提示而非静默丢弃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-svc-int-'));
  const agents = { get: () => makeFakeAgent('sess-a'), roots: () => [] };
  const ctx = makeFakeCtx(agents);
  const stop = startResumeService(ctx, { dir, heartbeatPath: path.join(dir, 'hb.json') });
  try {
    const id = 'bom-req';
    fs.writeFileSync(path.join(dir, `req-${id}.json`), '\uFEFF' + JSON.stringify({ id, text: '带BOM' }));
    const resp = await waitForResponseFile(id, 8000, 100, dir);
    assert.ok(resp, '应收到响应');
    assert.equal(resp.ok, false);
    assert.ok(resp.error.includes('格式无效'), '应提示请求格式无效');
    assert.ok(!fs.existsSync(path.join(dir, `req-${id}.json`)), '损坏请求文件应被消费');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
