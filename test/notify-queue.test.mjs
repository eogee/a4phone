// notify 队列单元测试：queueNotify 写入请求、processNotifyQueue 代发并清理、过期/损坏丢弃
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queueNotify, processNotifyQueue } from '../src/notify.mjs';

function tempQueueDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-notify-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

test('queueNotify 写入请求文件，processNotifyQueue 代发并删除', (t) => {
  const dir = tempQueueDir(t);
  const shown = [];
  assert.equal(queueNotify('标题', '内容', dir), true);

  const files = jsonFiles(dir);
  assert.equal(files.length, 1);
  const req = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
  assert.equal(req.title, '标题');
  assert.equal(req.message, '内容');
  assert.ok(Number.isFinite(req.ts));

  const n = processNotifyQueue({ queueDir: dir, show: (title, message) => shown.push([title, message]) });
  assert.equal(n, 1);
  assert.deepEqual(shown, [['标题', '内容']]);
  assert.equal(jsonFiles(dir).length, 0, '处理后请求文件应删除');
});

test('过期请求（超过 ttl）直接丢弃不弹', (t) => {
  const dir = tempQueueDir(t);
  const shown = [];
  queueNotify('旧', '通知', dir);
  const f = jsonFiles(dir)[0];
  const p = path.join(dir, f);
  const req = JSON.parse(fs.readFileSync(p, 'utf-8'));
  req.ts = Date.now() - 10 * 60 * 1000;
  fs.writeFileSync(p, JSON.stringify(req));

  const n = processNotifyQueue({ queueDir: dir, show: () => shown.push(1), ttlMs: 60_000 });
  assert.equal(n, 0);
  assert.equal(shown.length, 0);
  assert.equal(jsonFiles(dir).length, 0, '过期文件应被清理');
});

test('损坏请求文件直接删除不弹', (t) => {
  const dir = tempQueueDir(t);
  fs.writeFileSync(path.join(dir, 'broken.json'), 'not-json{{');
  const n = processNotifyQueue({ queueDir: dir, show: () => { throw new Error('不应调用'); } });
  assert.equal(n, 0);
  assert.equal(fs.existsSync(path.join(dir, 'broken.json')), false);
});

test('show 抛异常时请求文件仍被删除（不重复弹）', (t) => {
  const dir = tempQueueDir(t);
  queueNotify('x', 'y', dir);
  assert.throws(() => processNotifyQueue({ queueDir: dir, show: () => { throw new Error('boom'); } }));
  assert.equal(jsonFiles(dir).length, 0);
});

test('非 .json 文件（写入中的临时文件）被忽略', (t) => {
  const dir = tempQueueDir(t);
  fs.writeFileSync(path.join(dir, 'notify-1.tmp'), 'partial');
  const shown = [];
  const n = processNotifyQueue({ queueDir: dir, show: () => shown.push(1) });
  assert.equal(n, 0);
  assert.equal(shown.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'notify-1.tmp')), '临时文件应保留（由原子写 rename 接管）');
});

test('队列目录不存在时安全返回 0', () => {
  const dir = path.join(os.tmpdir(), `a4p-notify-missing-${Date.now()}`);
  const n = processNotifyQueue({ queueDir: dir, show: () => {} });
  assert.equal(n, 0);
});
