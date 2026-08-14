// configureDsh / unconfigureDsh 单元测试：
//   旧版手动挂载替换、幂等跳过、缺失 profile 跳过、
//   卸载保留头注释与其他插件条目、往返一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureDsh, unconfigureDsh } from '../src/setup.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-dsh-test-'));
}

// 模拟 DSH loader 写入的 profile patch 头注释
const HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
].join('\n');

// 旧版手动挂载（指向 C:\ProgramMine\dsh-hook），来自整合前的真实状态
const LEGACY_INSERT = [
  '',
  '# dsh-hook: hook 插件（任务完成 / 权限请求 / 问题询问）',
  '- insert:',
  '    - id: dsh-hook',
  '      name: "../../../../../ProgramMine/dsh-hook/lib/index.js"',
  '      config:',
  '        logDir: "C:/ProgramMine/dsh-hook/logs"',
].join('\n');

// 用户自己的其他插件条目，配置/卸载都应原样保留
const OTHER_INSERT = [
  '',
  '- insert:',
  '    - id: my-plugin',
  '      name: "@me/my-plugin"',
  '      config:',
  '        foo: bar',
].join('\n');

// 构造一个带头部 + 旧挂载 + 其他条目的 patch 文件
function legacyPatch() {
  return HEADER + LEGACY_INSERT + OTHER_INSERT + '\n';
}

// 测试用插件入口（位于临时目录的 node_modules/a4phone 下，与真实布局一致）
function pluginEntry(dir) {
  return path.join(dir, 'node_modules', 'a4phone', 'dsh', 'lib', 'index.js');
}

test('configureDsh 替换旧版手动挂载并写入新块，保留头部与其他条目', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchPath, legacyPatch());

  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');

  assert.equal(configureDsh({ profileDir, pluginEntry: entry }), true, '首次配置应写入');
  const out = fs.readFileSync(patchPath, 'utf-8');
  assert.ok(!out.includes('ProgramMine/dsh-hook'), '旧挂载应被移除');
  assert.ok(out.includes('a4phone/dsh/lib/index.js'), '应写入本包插件路径');
  assert.ok(out.includes(HEADER), 'profile 头注释应保留');
  assert.ok(out.includes('my-plugin'), '其他插件条目应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureDsh 幂等：已是最新块时返回 false 且不重写', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');

  assert.equal(configureDsh({ profileDir, pluginEntry: entry }), true);
  const once = fs.readFileSync(patchPath, 'utf-8');
  assert.equal(configureDsh({ profileDir, pluginEntry: entry }), false, '重复配置应跳过');
  assert.equal(fs.readFileSync(patchPath, 'utf-8'), once, '文件不应被重写');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureDsh 无 DSH profile 目录时跳过', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web'); // 不创建
  assert.equal(configureDsh({ profileDir, pluginEntry: pluginEntry(dir) }), false);
  assert.ok(!fs.existsSync(profileDir), '不应创建 profile 目录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configureDsh 全新 profile（无 patch 文件）时创建 patch', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');

  assert.equal(configureDsh({ profileDir, pluginEntry: entry }), true);
  const out = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf-8');
  assert.ok(out.includes('id: dsh-hook'));
  assert.ok(out.includes('a4phone/dsh/lib/index.js'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureDsh 移除挂载，保留头注释与其他条目', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');
  fs.writeFileSync(patchPath, legacyPatch());

  configureDsh({ profileDir, pluginEntry: entry });
  assert.equal(unconfigureDsh({ profileDir }), true, '卸载应改写');

  const out = fs.readFileSync(patchPath, 'utf-8');
  assert.ok(!out.includes('a4phone dsh-hook (auto-generated)'), 'marker 块应移除');
  assert.ok(!out.includes('id: dsh-hook'), 'dsh-hook 挂载应移除');
  assert.ok(out.includes(HEADER), '头注释应保留');
  assert.ok(out.includes('my-plugin'), '其他插件条目应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureDsh 已移除旧挂载（旧版 ProgramMine 挂载也能清理）', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchPath, HEADER + LEGACY_INSERT + '\n');

  assert.equal(unconfigureDsh({ profileDir }), true);
  const out = fs.readFileSync(patchPath, 'utf-8');
  assert.ok(!out.includes('id: dsh-hook'), '旧挂载应清理');
  assert.ok(out.includes(HEADER), '头注释应保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureDsh 无 dsh-hook 挂载时返回 false 不重写', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const original = HEADER + OTHER_INSERT + '\n';
  fs.writeFileSync(patchPath, original);

  assert.equal(unconfigureDsh({ profileDir }), false);
  assert.equal(fs.readFileSync(patchPath, 'utf-8'), original, '文件应原样保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureDsh patch 文件不存在时返回 false', () => {
  const dir = tmpdir();
  const profileDir = path.join(dir, 'profiles', 'web'); // 不创建 patch
  assert.equal(unconfigureDsh({ profileDir }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
