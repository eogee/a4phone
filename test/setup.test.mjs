// unregisterHooks / configureCodex / unconfigureCodex / configureZcode 单元测试：
//   卸载不重写无 a4phone Hook 的 settings.json、保留用户 Hook、
//   Codex 配置可配置/卸载往返、features hooks 空壳清理、ZCode 配置往返
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  unregisterHooks,
  configureCodex,
  unconfigureCodex,
  configureZcode,
  unconfigureZcode,
  configureCodebuddy,
  unconfigureCodebuddy,
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

test('configureZcode → unconfigureZcode 往返：写入 events 与 enabled，卸载恢复且保留用户配置', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'config.json');
  const original = { mcp: { servers: { fs: { command: 'node' } } }, hooks: { events: {} } };
  fs.writeFileSync(p, JSON.stringify(original, null, 2));

  assert.equal(configureZcode(p), true, '首次配置应写入');
  const configured = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(configured.hooks.enabled, true, '配置文件 Hook 默认禁用，应显式开启');
  const str = JSON.stringify(configured);
  assert.ok(str.includes('a4p hook zcode'), '配置应含 a4phone Hook');
  for (const ev of ['Stop', 'PreToolUse', 'PermissionRequest']) {
    assert.ok(configured.hooks.events[ev], `${ev} 事件应写入`);
  }
  assert.ok(configured.mcp?.servers?.fs, '用户 mcp 配置应保留');

  assert.equal(configureZcode(p), false, '重复配置应幂等跳过');

  assert.equal(unconfigureZcode(p), true, '卸载应改写');
  const restored = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.ok(!JSON.stringify(restored).includes('a4p hook zcode'), '卸载后不应再有 a4phone Hook');
  assert.ok(restored.mcp?.servers?.fs, '用户 mcp 配置应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureZcode 无 a4phone Hook 时不重写文件（保留原格式）', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'config.json');
  const original = '{"hooks":{"enabled":true,"events":{"Stop":[{"matcher":"x","hooks":[{"type":"command","command":"echo hi"}]}]}}}\n';
  fs.writeFileSync(p, original);

  assert.equal(unconfigureZcode(p), false, '无 a4phone Hook 时应返回 false（未改写）');
  assert.equal(fs.readFileSync(p, 'utf-8'), original, '文件应原样保留，不被格式化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureZcode：Hook 已存在但 runner 被禁用时仍补开 enabled', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'config.json');
  const input = {
    hooks: {
      enabled: false,
      events: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'a4p hook zcode' }] }],
      },
    },
  };
  fs.writeFileSync(p, JSON.stringify(input, null, 2));

  assert.equal(configureZcode(p), true, 'enabled 修正应算一次写入');
  const out = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(out.hooks.enabled, true, '应补开 enabled');
  assert.equal(out.hooks.events.Stop.length, 1, '已存在的 Hook 不应重复追加');
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

test('configureCodebuddy → unconfigureCodebuddy 往返：写入 hooks 并保留用户配置', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'settings.json');
  const original = { enabledPlugins: { 'docx@codebuddy-plugins-official': true } };
  fs.writeFileSync(p, JSON.stringify(original, null, 2));

  assert.equal(configureCodebuddy(p), true, '首次配置应写入');
  const configured = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const str = JSON.stringify(configured);
  assert.ok(str.includes('a4p hook codebuddy'), '配置应含 a4phone Hook');
  for (const ev of ['Stop', 'PreToolUse', 'PermissionRequest']) {
    assert.ok(configured.hooks[ev], `${ev} 事件应写入`);
  }
  assert.ok(configured.enabledPlugins?.['docx@codebuddy-plugins-official'], '用户 enabledPlugins 应保留');

  assert.equal(configureCodebuddy(p), false, '重复配置应幂等跳过');

  assert.equal(unconfigureCodebuddy(p), true, '卸载应改写');
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.ok(!JSON.stringify(after).includes('a4p hook codebuddy'), '卸载后不应有 a4phone Hook');
  assert.ok(after.enabledPlugins?.['docx@codebuddy-plugins-official'], '卸载后用户配置应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureCodebuddy 无 a4phone Hook 时不重写文件', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'settings.json');
  const original = { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  fs.writeFileSync(p, JSON.stringify(original, null, 2));

  assert.equal(unconfigureCodebuddy(p), false, '无 a4phone Hook 时应返回 false（未改写）');
  assert.equal(fs.readFileSync(p, 'utf-8'), JSON.stringify(original, null, 2), '文件应原样保留');
  fs.rmSync(dir, { recursive: true, force: true });
});
