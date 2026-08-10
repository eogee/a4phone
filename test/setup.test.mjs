// unregisterHooks / configureCodex / unconfigureCodex 单元测试：
//   卸载不重写无 a4phone Hook 的 settings.json、保留用户 Hook、
//   Codex 配置可配置/卸载往返、features hooks 空壳清理
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  unregisterHooks,
  configureCodex,
  unconfigureCodex,
  stripFeaturesHooksShell,
} from '../src/setup.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-setup-test-'));
}

test('unregisterHooks 无 a4phone Hook 时不重写文件（保留原格式）', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'settings.json');
  // 用户自有 Hook，非 a4phone，且缩进格式非默认 2 空格——卸载不应动它
  const original = '{"hooks":{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"echo hi"}]}]}}\n';
  fs.writeFileSync(p, original);

  const result = unregisterHooks(p);
  assert.equal(result, false, '无 a4phone Hook 时应返回 false（未改写）');
  assert.equal(fs.readFileSync(p, 'utf-8'), original, '文件应原样保留，不被格式化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unregisterHooks 移除 a4phone Hook、保留用户 Hook', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'settings.json');
  const input = {
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'a4p hook' }] }],
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'a4p hook' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user' }] },
      ],
    },
  };
  fs.writeFileSync(p, JSON.stringify(input, null, 2));

  const result = unregisterHooks(p);
  assert.equal(result, true, '有 a4phone Hook 时应返回 true（已改写）');

  const out = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.ok(!JSON.stringify(out).includes('a4p hook'), 'a4phone Hook 应全部移除');
  assert.ok(out.hooks.PreToolUse.some((b) => b.hooks.some((h) => h.command === 'echo user')), '用户 Hook 应保留');
  assert.equal(out.hooks.Stop, undefined, 'a4phone 独占的 Stop 事件应整体删除');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unregisterHooks 文件不存在时不创建文件', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'nonexistent', 'settings.json'); // 父目录也不存在
  const result = unregisterHooks(p);
  assert.equal(result, false);
  assert.ok(!fs.existsSync(p), '不应创建 settings.json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureCodex → unconfigureCodex 往返：无 [features] 时回到原样', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'config.toml');
  const original = 'model = "gpt-5"\n';
  fs.writeFileSync(p, original);

  assert.equal(configureCodex(p), true, '首次配置应写入');
  const configured = fs.readFileSync(p, 'utf-8');
  assert.ok(configured.includes('a4p hook codex'), '配置应含 a4phone Hook');

  unconfigureCodex(p);
  const restored = fs.readFileSync(p, 'utf-8');
  assert.ok(!restored.includes('a4p hook codex'), '卸载后不应再有 a4phone Hook');
  assert.ok(!restored.includes('hooks = true'), '无 [features] 时 [features] hooks = true 应一并移除');
  assert.ok(restored.includes('model = "gpt-5"'), '用户内容应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureCodex → unconfigureCodex 往返：已有 [features] 且含其他键时保留用户键、移除空壳', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'config.toml');
  const original = '[features]\ndynamic_time_range = false\n\n[model]\nprovider = "openai"\n';
  fs.writeFileSync(p, original);

  configureCodex(p);
  const configured = fs.readFileSync(p, 'utf-8');
  assert.ok(configured.includes('hooks = true'), '应向 [features] 表插入 hooks = true');
  assert.ok(configured.includes('dynamic_time_range'), '用户 features 键应保留');

  unconfigureCodex(p);
  const restored = fs.readFileSync(p, 'utf-8');
  assert.ok(!restored.includes('a4p hook codex'), 'a4phone Hook 应移除');
  assert.ok(restored.includes('dynamic_time_range = false'), '用户 features 键应保留');
  assert.ok(restored.includes('hooks = true'), '用户有 hooks = true（非空壳）时保留');
  assert.ok(restored.includes('provider = "openai"'), '[model] 表应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stripFeaturesHooksShell：仅移除只剩 hooks = true 的空壳表', () => {
  // 空壳：表体只有 hooks = true → 整表移除
  assert.equal(stripFeaturesHooksShell('[features]\nhooks = true\n'), '');
  // 有注释的空壳（空壳块连同其尾随空行被吞掉）
  assert.equal(
    stripFeaturesHooksShell('# a4phone hooks\n[features]\n# enabled by a4phone\nhooks = true\n'),
    '# a4phone hooks'
  );
  // 表里还有其他键：保留
  const withOther = '[features]\nhooks = true\ndynamic_time_range = false\n';
  assert.equal(stripFeaturesHooksShell(withOther), withOther);
  // 非 [features] 表不受影响
  const otherTable = '[features.oauth]\nenabled = true\n';
  assert.equal(stripFeaturesHooksShell(otherTable), otherTable);
  // 无 hooks 的普通 [features] 不受影响
  const plain = '[features]\ndynamic_time_range = true\n';
  assert.equal(stripFeaturesHooksShell(plain), plain);
});
