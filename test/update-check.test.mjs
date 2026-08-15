// update-check 单元测试：版本比对、限频、提醒去重、开关、缓存
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareVersions,
  getLocalVersion,
  loadCache,
  checkForUpdate,
} from '../src/update-check.mjs';

const tmpCache = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-upd-'));
  return path.join(dir, 'cache.json');
};

test('compareVersions：大小比较与版本号长度差异', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.1', '1.2.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1, '10 > 9（数值比较非字典序）');
  assert.equal(compareVersions('1.2', '1.2.0'), 0, '1.2 == 1.2.0');
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('getLocalVersion：读取当前包版本', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  assert.equal(getLocalVersion(), pkg.version, '应与 package.json 版本一致');
});

test('checkForUpdate：checkUpdates=false 时跳过', async () => {
  const cachePath = tmpCache();
  const out = await checkForUpdate({
    config: { checkUpdates: false },
    cachePath,
    latestVersion: '9.9.9',
    localVersion: '1.0.0',
  });
  assert.equal(out.checked, false);
  assert.equal(out.hasUpdate, false);
  assert.ok(!fs.existsSync(cachePath), '关闭时不应写缓存');
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('checkForUpdate：未到期（限频）时跳过且不访问网络', async () => {
  const cachePath = tmpCache();
  fs.writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), knownLatest: null }));
  const out = await checkForUpdate({
    config: {},
    cachePath,
    now: Date.now(),
    latestVersion: '9.9.9',
    localVersion: '1.0.0',
  });
  assert.equal(out.checked, false, '间隔内不应检查');
  assert.equal(out.latest, null);
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('checkForUpdate：查询失败（latestVersion=null）时静默跳过', async () => {
  const cachePath = tmpCache();
  const out = await checkForUpdate({
    config: {},
    cachePath,
    now: Date.now(),
    latestVersion: null, // 模拟网络失败
    localVersion: '1.0.0',
  });
  assert.equal(out.checked, true);
  assert.equal(out.hasUpdate, false);
  assert.equal(out.latest, null);
  assert.ok(!fs.existsSync(cachePath), '失败不写缓存，下次可重试');
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('checkForUpdate：发现新版本 → 提醒一次并缓存 knownLatest', async () => {
  const cachePath = tmpCache();
  const notified = [];
  const now = Date.now();

  const first = await checkForUpdate({
    config: {},
    cachePath,
    now,
    localVersion: '1.0.0',
    latestVersion: '1.2.0',
    notify: async (latest) => { notified.push(latest); },
  });
  assert.equal(first.checked, true);
  assert.equal(first.hasUpdate, true);
  assert.equal(first.notified, true);
  assert.deepEqual(notified, ['1.2.0'], '应提醒一次');
  assert.deepEqual(loadCache(cachePath), { lastCheck: now, knownLatest: '1.2.0' });

  // 再次检查（间隔外）：同一新版本不再提醒
  const second = await checkForUpdate({
    config: {},
    cachePath,
    now: now + 10 * 3600 * 1000, // 10 小时后
    localVersion: '1.0.0',
    latestVersion: '1.2.0',
    notify: async (latest) => { notified.push(latest); },
  });
  assert.equal(second.hasUpdate, true);
  assert.equal(second.notified, false, '已提醒过的版本不应重复提醒');
  assert.deepEqual(notified, ['1.2.0']);
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('checkForUpdate：无新版本时不提醒，保留 knownLatest', async () => {
  const cachePath = tmpCache();
  const notified = [];
  const now = Date.now();
  const out = await checkForUpdate({
    config: {},
    cachePath,
    now,
    localVersion: '1.2.0',
    latestVersion: '1.2.0',
    notify: async (latest) => { notified.push(latest); },
  });
  assert.equal(out.hasUpdate, false);
  assert.equal(out.notified, false);
  assert.deepEqual(notified, []);
  assert.equal(loadCache(cachePath).lastCheck, now);
  assert.equal(loadCache(cachePath).knownLatest, undefined);
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('checkForUpdate：提醒失败时不记录 knownLatest，下次重试', async () => {
  const cachePath = tmpCache();
  const now = Date.now();
  const out = await checkForUpdate({
    config: {},
    cachePath,
    now,
    localVersion: '1.0.0',
    latestVersion: '1.2.0',
    notify: async () => { throw new Error('推送失败'); },
  });
  assert.equal(out.notified, false);
  const cache = loadCache(cachePath);
  assert.equal(cache.knownLatest, undefined, '提醒失败不应标记已提醒');
  assert.equal(cache.lastCheck, now, '但应记录检查时间');
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});
