// waitForResponse 回归测试：本地 mock 一个 ntfy /json NDJSON 流
//   覆盖 open 事件跳过、action 点选匹配、自由文本、requestId 不匹配超时
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { waitForResponse, parseNtfyMessage } from '../src/ntfy.mjs';

// 启动一个逐行发送 NDJSON 的本地流
function startServer(lines, { interval = 30, endAfter = true } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let i = 0;
      const timer = setInterval(() => {
        if (i < lines.length) {
          res.write(lines[i++] + '\n');
        } else if (endAfter) {
          clearInterval(timer);
          res.end();
        }
      }, interval);
      req.on('close', () => clearInterval(timer));
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const base = (server, port) => ({ server: `http://127.0.0.1:${port}`, topic: 'a4p-test', timeout: 5000 });

test('连接后的 open 事件（无 message 字段）会被跳过，等待手机点选回执', async () => {
  const { server, port } = await startServer([
    '{"event":"open","topic":"a4p-test-response","time":123}',
    '{"event":"message","topic":"a4p-test-response","message":"{\\"requestId\\":\\"req-1\\",\\"answer\\":\\"Yes\\"}"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1' });
    assert.deepEqual(resp, { requestId: 'req-1', answer: 'Yes' });
  } finally {
    server.close();
  }
});

test('手机自由文本（非 JSON）作为答案返回', async () => {
  const { server, port } = await startServer([
    '{"event":"open","topic":"a4p-test-response"}',
    '{"event":"message","topic":"a4p-test-response","message":"明天下午三点"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1' });
    assert.deepEqual(resp, { answer: '明天下午三点' });
  } finally {
    server.close();
  }
});

test('多选项数字回复：纯数字"4"是合法 JSON，必须按自由文本接受（回归：编号回复失效 bug）', async () => {
  const { server, port } = await startServer([
    '{"event":"open","topic":"a4p-test-response"}',
    '{"event":"message","topic":"a4p-test-response","message":"4"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1' });
    assert.deepEqual(resp, { answer: '4' }, '数字自由文本应原样作为答案返回');
  } finally {
    server.close();
  }
});

test('数字回复映射回选项 label（与 asku.mjs 相同逻辑）', () => {
  const options = ['爬山', '看电影', '宅家', '去公园散步'];
  const answer = '4';
  const idx = Number(String(answer).trim());
  assert.equal(idx, 4);
  assert.ok(Number.isInteger(idx) && idx >= 1 && idx <= options.length);
  assert.equal(options[idx - 1], '去公园散步');
});

test('布尔/其他 JSON 原始值自由文本按文本接受', async () => {
  const { server, port } = await startServer([
    '{"event":"open","topic":"a4p-test-response"}',
    '{"event":"message","topic":"a4p-test-response","message":"true"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1' });
    assert.deepEqual(resp, { answer: 'true' });
  } finally {
    server.close();
  }
});

test('parseNtfyMessage：JSON 对象返回对象，原始值/文本原样返回', () => {
  assert.deepEqual(parseNtfyMessage('{"requestId":"x","answer":"y"}'), { requestId: 'x', answer: 'y' });
  assert.equal(parseNtfyMessage('4'), '4', '数字字面量按文本');
  assert.equal(parseNtfyMessage('true'), 'true', '布尔字面量按文本');
  assert.equal(parseNtfyMessage('null'), 'null', 'null 字面量按文本');
  assert.equal(parseNtfyMessage('明天下午三点'), '明天下午三点', '普通文本原样');
  assert.equal(parseNtfyMessage('03'), '03', '前导零数字原样（非法 JSON）');
  assert.equal(parseNtfyMessage(''), '');
});

test('requestId 不匹配的回执不会被接受', async () => {
  // 只发一个 requestId 不匹配的消息，随后断开 → 应返回 null（等待超时）
  const { server, port } = await startServer([
    '{"event":"open","topic":"a4p-test-response"}',
    '{"event":"message","topic":"a4p-test-response","message":"{\\"requestId\\":\\"other\\",\\"answer\\":\\"No\\"}"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1', timeout: 300 });
    assert.equal(resp, null);
  } finally {
    server.close();
  }
});

test('无任何消息事件时在超时后返回 null', async () => {
  // 只发 open 事件并保持连接，客户端应在 timeout 后 abort 并返回 null
  const { server, port } = await startServer(
    ['{"event":"open","topic":"a4p-test-response"}'],
    { endAfter: false }
  );
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1', timeout: 200 });
    assert.equal(resp, null);
  } finally {
    server.close();
  }
});
