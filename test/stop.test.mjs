import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

test('Stop 手机通知使用首条真实提问作为标题', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-stop-test-'));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '@image#1:shot.png 修复登录页' },
  }) + '\n');

  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stateDir = path.join(home, '.a4phone');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    topic: 'a4p-test',
    server: `http://127.0.0.1:${server.address().port}`,
  }));
  // A live parent PID routes desktop notification to the queue instead of spawning a toast.
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: process.pid }));

  const moduleUrl = new URL('../src/stop.mjs', import.meta.url).href;
  const input = {
    session_id: 'session-1',
    cwd: path.join(home, 'demo'),
    transcript_path: transcript,
    last_assistant_message: '已修复',
  };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { handleStop } = await import(process.env.STOP_MODULE_URL);
    await handleStop(JSON.parse(process.env.STOP_INPUT), 'Claude Code');
  `], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      A4P_RESUME: '',
      STOP_MODULE_URL: moduleUrl,
      STOP_INPUT: JSON.stringify(input),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, '修复登录页');
  assert.match(requests[0].message, /任务已完成/);
  assert.match(requests[0].message, /AI 最后输出：\n已修复/);
});
