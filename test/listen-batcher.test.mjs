// createBatcher 单元测试：积压合并、串行执行、过时丢弃继续、恢复
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatcher } from '../src/batcher.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('忙时到达的消息合并为一个批次，一条 run 处理全部', async () => {
  const calls = [];
  const gate = deferred();
  const run = async ({ text, count, msgTime }) => {
    calls.push({ text, count, msgTime });
    if (calls.length === 1) await gate.promise; // 第一条阻塞模拟长轮次
    return true;
  };
  const b = createBatcher({ run });

  const drain = b.submit('m1', 100); // 进入长轮次
  await tick();
  b.submit('m2', 101);
  b.submit('m3', 102);
  assert.equal(b.pendingCount, 2, '忙时应积压 2 条');

  gate.resolve();
  await drain;

  assert.equal(calls.length, 2, '应只有 2 个批次（m1 与合并后的 m2+m3）');
  assert.equal(calls[0].text, 'm1');
  assert.equal(calls[1].text, 'm2\n\nm3', '积压消息应合并为一条');
  assert.equal(calls[1].count, 2);
  assert.equal(calls[1].msgTime, 101, '批次时间取最早消息时间');
  assert.equal(b.pendingCount, 0);
});

test('批次处理返回 false（过时丢弃）后继续处理下一批，不阻塞', async () => {
  const calls = [];
  const gate = deferred();
  const run = async ({ text }) => {
    calls.push(text);
    if (text === 'first') await gate.promise;
    return text !== 'first'; // first 被判过时丢弃
  };
  const b = createBatcher({ run });

  const drain = b.submit('first', 1);
  await tick();
  b.submit('keep', 2); // first 处理期间到达
  gate.resolve();
  await drain;

  assert.deepEqual(calls, ['first', 'keep'], '丢弃后应立即继续下一批，无需等新消息');
  assert.equal(b.pendingCount, 0);
});

test('restore 恢复上次未处理的批次并触发处理', async () => {
  const calls = [];
  const run = async ({ text, count }) => { calls.push({ text, count }); return true; };
  const b = createBatcher({ run });

  b.restore(['r1', 'r2'], 42);
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'r1\n\nr2');
  assert.equal(calls[0].count, 2);
  assert.equal(b.pendingCount, 0);

  // 空恢复无副作用
  b.restore([], null);
  b.restore(null, null);
  assert.equal(calls.length, 1);
});

test('pendingSnapshot 反映当前积压内容（供持久化）', async () => {
  const gate = deferred();
  const run = async () => { await gate.promise; return true; };
  const b = createBatcher({ run });

  const drain = b.submit('a', 1);
  await tick();
  b.submit('b', 3);

  assert.deepEqual(b.pendingSnapshot(), { texts: ['b'], msgTime: 3 });
  gate.resolve();
  await drain;
  assert.deepEqual(b.pendingSnapshot(), { texts: [], msgTime: null });
});

test('run 抛异常时跳过该批并继续后续批次', async () => {
  const calls = [];
  const gate = deferred();
  const run = async ({ text }) => {
    calls.push(text);
    if (text === 'bad') { await gate.promise; throw new Error('boom'); }
    return true;
  };
  const b = createBatcher({ run });

  const drain = b.submit('bad', 1);
  await tick();
  b.submit('good', 2);
  gate.resolve();
  await drain;

  assert.deepEqual(calls, ['bad', 'good'], '异常批次跳过，后续批次继续');
  assert.equal(b.pendingCount, 0);
});
