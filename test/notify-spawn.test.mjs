// 通知 spawn 的容错：命令不存在时 spawn 会发 'error' 事件，无监听器即为
// unhandled error（直接杀掉 DSH / Codex 这类常驻宿主进程），必须有监听器兜住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDetached } from '../src/notify.mjs';

test('spawnDetached 挂载 error 监听器：命令不存在时静默降级不崩溃', async () => {
  const child = spawnDetached('a4p-no-such-command-xyz', ['x'], { stdio: 'ignore' });
  assert.ok(child.listenerCount('error') > 0, '必须挂 error 监听器，否则 ENOENT 会杀掉宿主进程');

  // 真正触发一次失败：若有未捕获的 'error' 事件，测试进程会直接崩掉
  await new Promise((r) => setTimeout(r, 100));
});
