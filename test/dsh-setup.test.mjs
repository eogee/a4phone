// configureDsh / unconfigureDsh 单元测试：
//   旧版手动挂载替换、幂等跳过、缺失 profile 跳过、
//   卸载保留头注释与其他插件条目、往返一致、
//   多 profile 发现（cordis.yml 身份文件过滤）、批量挂载/卸载
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureDsh, unconfigureDsh, discoverDshProfiles } from '../src/setup.mjs';
import { ensureDshProfiles } from '../src/listen.mjs';

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

// ── 多 profile 发现与批量挂载 ─────────────────────────────────────────

// 构造多 profile 环境：web 预置「头注释 + 旧手动挂载 + 其他插件」的 patch，
// tui/dsh-tui 为全新 profile（仅 cordis.yml）；node_modules 与空目录应被排除
function multiProfileDir() {
  const dir = tmpdir();
  const profilesDir = path.join(dir, 'profiles');
  for (const name of ['web', 'tui', 'dsh-tui']) {
    fs.mkdirSync(path.join(profilesDir, name), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, name, 'cordis.yml'), '# profile\n');
  }
  fs.writeFileSync(path.join(profilesDir, 'web', 'cordis.patch.yml'), legacyPatch());
  fs.mkdirSync(path.join(profilesDir, 'node_modules'), { recursive: true }); // 非 profile
  fs.mkdirSync(path.join(profilesDir, 'empty'), { recursive: true }); // 无 cordis.yml，非 profile
  return { dir, profilesDir };
}

test('discoverDshProfiles 只返回含 cordis.yml 的子目录', () => {
  const { dir, profilesDir } = multiProfileDir();
  const found = discoverDshProfiles(profilesDir).map((p) => path.basename(p)).sort();
  assert.deepEqual(found, ['dsh-tui', 'tui', 'web']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discoverDshProfiles 目录不存在时返回空数组', () => {
  assert.deepEqual(discoverDshProfiles(path.join(tmpdir(), 'no-such-dir')), []);
});

test('configureDsh 批量模式挂载全部 profile 并返回 mounted 列表', () => {
  const { dir, profilesDir } = multiProfileDir();
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');

  const r = configureDsh({ profilesDir, pluginEntry: entry });
  assert.equal(r.scanned, 3);
  assert.deepEqual([...r.mounted].sort(), ['dsh-tui', 'tui', 'web']);

  // web：旧挂载被替换，头注释与其他插件条目保留
  const webOut = fs.readFileSync(path.join(profilesDir, 'web', 'cordis.patch.yml'), 'utf-8');
  assert.ok(!webOut.includes('ProgramMine/dsh-hook'), '旧挂载应被移除');
  assert.ok(webOut.includes('id: dsh-hook'), '应写入新挂载');
  assert.ok(webOut.includes(HEADER), 'web 头注释应保留');
  assert.ok(webOut.includes('my-plugin'), '其他插件条目应保留');

  // 全新 profile：创建 patch 并挂载
  for (const name of ['tui', 'dsh-tui']) {
    const out = fs.readFileSync(path.join(profilesDir, name, 'cordis.patch.yml'), 'utf-8');
    assert.ok(out.includes('id: dsh-hook'), `${name} 应已挂载`);
  }
  // 幂等：再次扫描无新挂载
  const again = configureDsh({ profilesDir, pluginEntry: entry });
  assert.deepEqual(again.mounted, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconfigureDsh 批量模式清理所有 profile 的挂载', () => {
  const { dir, profilesDir } = multiProfileDir();
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');
  configureDsh({ profilesDir, pluginEntry: entry });

  assert.equal(unconfigureDsh({ profilesDir }), true, '任一清理即返回 true');
  for (const name of ['web', 'tui', 'dsh-tui']) {
    const out = fs.readFileSync(path.join(profilesDir, name, 'cordis.patch.yml'), 'utf-8');
    assert.ok(!out.includes('id: dsh-hook'), `${name} 挂载应移除`);
  }
  assert.ok(fs.readFileSync(path.join(profilesDir, 'web', 'cordis.patch.yml'), 'utf-8').includes(HEADER),
    'web 头注释应保留');
  assert.equal(unconfigureDsh({ profilesDir }), false, '再次清理应返回 false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureDshProfiles 新挂载时写日志并返回列表，重复调用静默', () => {
  const { dir, profilesDir } = multiProfileDir();
  const entry = pluginEntry(dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// placeholder\n');

  const logs = [];
  const first = ensureDshProfiles((m) => logs.push(m), { profilesDir, pluginEntry: entry });
  assert.deepEqual([...first].sort(), ['dsh-tui', 'tui', 'web'], '首次应返回新挂载列表');
  assert.equal(logs.length, 1, '首次应写一条日志');

  const second = ensureDshProfiles((m) => logs.push(m), { profilesDir, pluginEntry: entry });
  assert.deepEqual(second, [], '重复调用无新挂载');
  assert.equal(logs.length, 1, '不应重复写日志');
  fs.rmSync(dir, { recursive: true, force: true });
});
