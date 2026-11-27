// waitForResponse 回归测试：本地 mock 一个 ntfy /json NDJSON 流
//   覆盖 open 事件跳过、action 点选匹配、自由文本、requestId 不匹配超时
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { MAX_MESSAGE_BYTES, ntfyAuthHeaders, ntfyFailureReason, parseNtfyMessage, sendNotification, truncateUtf8, waitForResponse } from '../src/ntfy.mjs';

// 启动一个逐行发送 NDJSON 的本地流
function startServer(lines, { interval = 30, endAfter = true } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.headers);
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
    server.listen(0, () => resolve({ server, port: server.address().port, requests }));
  });
}

const base = (server, port) => ({ server: `http://127.0.0.1:${port}`, topic: 'a4p-test', timeout: 5000 });

async function startPostServer(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, requests };
}

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

test('ntfyAuthHeaders：仅在有令牌时发送 Bearer 鉴权', () => {
  assert.deepEqual(ntfyAuthHeaders('  tk_1  '), { Authorization: 'Bearer tk_1' });
  assert.deepEqual(ntfyAuthHeaders(''), {});
  assert.deepEqual(ntfyAuthHeaders(undefined), {});
});

test('truncateUtf8：按字节限制且不切断 UTF-8 字符', () => {
  assert.equal(truncateUtf8('a'.repeat(5000)), 'a'.repeat(MAX_MESSAGE_BYTES - 3) + '...');
  const chinese = truncateUtf8('字'.repeat(2000));
  assert.ok(Buffer.byteLength(chinese, 'utf8') <= MAX_MESSAGE_BYTES);
  assert.ok(chinese.endsWith('...'));
  assert.equal(chinese.includes('\uFFFD'), false);
  assert.equal(truncateUtf8('短消息'), '短消息');
});

test('sendNotification：携带令牌并在发送前截断到 4KB', async () => {
  const { server, port, requests } = await startPostServer();
  try {
    const result = await sendNotification({
      server: `http://127.0.0.1:${port}`,
      topic: 'a4p-test',
      title: '标题',
      message: '字'.repeat(2000),
      token: 'tk_1',
    });
    assert.deepEqual(result, { ok: true, reason: '' });
    assert.equal(requests[0].headers.authorization, 'Bearer tk_1');
    assert.ok(Buffer.byteLength(requests[0].body.message, 'utf8') <= MAX_MESSAGE_BYTES);
    assert.ok(requests[0].body.message.endsWith('...'));

    const withoutToken = await sendNotification({
      server: `http://127.0.0.1:${port}`,
      topic: 'a4p-test',
      title: '标题',
      message: '短消息',
    });
    assert.equal(withoutToken.ok, true);
    assert.equal(requests[1].headers.authorization, undefined);
  } finally {
    server.close();
  }
});

test('sendNotification：403/429 返回明确原因', async () => {
  for (const [status, expected] of [[403, '令牌无效'], [429, '限速']]) {
    const { server, port } = await startPostServer(status);
    try {
      const result = await sendNotification({
        server: `http://127.0.0.1:${port}`,
        topic: 'a4p-test',
        title: '标题',
        message: '正文',
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, new RegExp(expected));
    } finally {
      server.close();
    }
  }
  assert.equal(ntfyFailureReason(500), 'HTTP 500');
});

test('sendNotification：网络错误和缺失话题返回失败原因', async () => {
  assert.deepEqual(await sendNotification({ server: 'http://127.0.0.1', topic: '', message: 'x' }), {
    ok: false,
    reason: '话题未配置',
  });

  const { server, port } = await startPostServer();
  await new Promise((resolve) => server.close(resolve));
  const result = await sendNotification({
    server: `http://127.0.0.1:${port}`,
    topic: 'a4p-test',
    title: '标题',
    message: '正文',
    timeoutMs: 500,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('waitForResponse：订阅携带 Bearer 令牌', async () => {
  const { server, port, requests } = await startServer([
    '{"event":"message","topic":"a4p-test-response","message":"{\\"requestId\\":\\"req-1\\",\\"answer\\":\\"Yes\\"}"}',
  ]);
  try {
    const resp = await waitForResponse({ ...base(server, port), requestId: 'req-1', token: 'tk_1' });
    assert.deepEqual(resp, { requestId: 'req-1', answer: 'Yes' });
    assert.equal(requests[0].authorization, 'Bearer tk_1');
  } finally {
    server.close();
  }
});
