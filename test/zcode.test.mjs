// zcode.mjs 单元测试：CLI 参数构造、回复提取、会话模型读取、模型配置同步
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildZcodeArgs,
  extractZcodeReply,
  readSessionModel,
  readProviderDef,
  ensureZcodeModelConfig,
} from '../src/zcode.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-zcode-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

test('buildZcodeArgs 构造 headless 续聊命令', () => {
  const { command, args } = buildZcodeArgs('帮我总结', 'sess_abc', 'C:/proj', 'C:/zcode.cjs');
  assert.equal(command, process.execPath, '直接用 node 可执行文件（绕过 cmd /c 引号问题）');
  assert.equal(args[0], 'C:/zcode.cjs');
  assert.ok(args.includes('--prompt'));
  assert.equal(args[args.indexOf('--prompt') + 1], '帮我总结');
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_abc');
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('--cwd') + 1], 'C:/proj');
  assert.ok(!args.includes('--max-turns'), '0.16.5 解析器未实现 --max-turns，不能传入');
});

test('extractZcodeReply 从 --json 输出提取 response', () => {
  const out = JSON.stringify({ sessionId: 's', response: '收到了', usage: { inputTokens: 1 } });
  assert.equal(extractZcodeReply(out), '收到了');
  assert.equal(extractZcodeReply('not json'), null);
  assert.equal(extractZcodeReply(''), null);
  assert.equal(extractZcodeReply(JSON.stringify({ sessionId: 's' })), null, '无 response 字段返回 null');
});

test('readSessionModel 从 rollout 读会话模型（取最后一次）', (t) => {
  const dir = tempDir(t);
  const rollout = path.join(dir, 'model-io-sess_s1.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ modelRef: { providerId: 'p1', modelId: 'm1' } }),
    JSON.stringify({ modelRef: { providerId: 'p2', modelId: 'm2' } }),
  ].join('\n'));
  assert.equal(readSessionModel('s1', dir), 'p2/m2', '取最后一次 modelRef');
  assert.equal(readSessionModel('nope', dir), null, 'rollout 不存在返回 null');
});

test('readProviderDef 从 v2 注册表读 provider 定义', (t) => {
  const dir = tempDir(t);
  const v2 = path.join(dir, 'config.json');
  fs.writeFileSync(v2, JSON.stringify({
    provider: {
      'p1': { name: 'my', kind: 'anthropic', options: { apiKey: 'sk-x', baseURL: 'https://x' }, source: 'custom' },
      'p2': { name: 'noopts', kind: 'openai' },
    },
  }));
  const def = readProviderDef('p1', v2);
  assert.deepEqual(def, { name: 'my', kind: 'anthropic', options: { apiKey: 'sk-x', baseURL: 'https://x' } });
  assert.equal(readProviderDef('p2', v2), null, '缺 options 视为不可用');
  assert.equal(readProviderDef('missing', v2), null);
});

test('ensureZcodeModelConfig：按会话模型同步，保留 hooks，幂等', (t) => {
  const dir = tempDir(t);
  const cfgPath = path.join(dir, 'cli-config.json');
  const v2 = path.join(dir, 'v2-config.json');
  const rollout = path.join(dir, 'rollout');
  fs.mkdirSync(rollout, { recursive: true });
  // 预置 hooks（模拟 a4p setup 写入的 ZCode hook 配置）
  fs.writeFileSync(cfgPath, JSON.stringify({ hooks: { enabled: true, events: {} } }));
  // 会话用的是 p1/m1，v2 注册表有 p1 定义
  fs.writeFileSync(path.join(rollout, 'model-io-sess_s1.jsonl'), JSON.stringify({ modelRef: { providerId: 'p1', modelId: 'm1' } }));
  fs.writeFileSync(v2, JSON.stringify({ provider: { p1: { name: 'p1n', kind: 'anthropic', options: { apiKey: 'k', baseURL: 'u' } } } }));

  const r1 = ensureZcodeModelConfig({ sessionId: 's1', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 });
  assert.equal(r1.ok, true);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.equal(cfg.model, 'p1/m1');
  assert.deepEqual(cfg.provider.p1, { name: 'p1n', kind: 'anthropic', options: { apiKey: 'k', baseURL: 'u' } });
  assert.ok(cfg.hooks?.enabled, 'hooks 配置被保留');

  // 幂等：再次调用不报错且不重复写入
  const r2 = ensureZcodeModelConfig({ sessionId: 's1', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 });
  assert.equal(r2.ok, true);
});

test('ensureZcodeModelConfig：切换模型后跟随新模型', (t) => {
  const dir = tempDir(t);
  const cfgPath = path.join(dir, 'cli-config.json');
  const v2 = path.join(dir, 'v2-config.json');
  const rollout = path.join(dir, 'rollout');
  fs.mkdirSync(rollout, { recursive: true });
  fs.writeFileSync(v2, JSON.stringify({ provider: { p1: { name: 'a', kind: 'anthropic', options: { apiKey: 'k', baseURL: 'u' } }, p2: { name: 'b', kind: 'openai', options: { apiKey: 'k2', baseURL: 'u2' } } } }));
  // 先写 p1/m1，会话随后切到 p2/m2
  fs.writeFileSync(path.join(rollout, 'model-io-sess_s1.jsonl'), JSON.stringify({ modelRef: { providerId: 'p1', modelId: 'm1' } }));
  assert.equal(ensureZcodeModelConfig({ sessionId: 's1', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 }).ok, true);
  fs.writeFileSync(path.join(rollout, 'model-io-sess_s1.jsonl'), JSON.stringify({ modelRef: { providerId: 'p2', modelId: 'm2' } }));
  assert.equal(ensureZcodeModelConfig({ sessionId: 's1', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 }).ok, true);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.equal(cfg.model, 'p2/m2', '跟随会话切换后的模型');
  assert.ok(cfg.provider.p2, '新 provider 定义已写入');
});

test('ensureZcodeModelConfig：rollout 缺失 / provider 缺失时给出明确失败', (t) => {
  const dir = tempDir(t);
  const cfgPath = path.join(dir, 'cli-config.json');
  const v2 = path.join(dir, 'v2-config.json');
  const rollout = path.join(dir, 'rollout');
  fs.mkdirSync(rollout, { recursive: true });
  fs.writeFileSync(v2, JSON.stringify({ provider: {} }));

  const r1 = ensureZcodeModelConfig({ sessionId: 'nope', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /rollout/);

  fs.writeFileSync(path.join(rollout, 'model-io-sess_s2.jsonl'), JSON.stringify({ modelRef: { providerId: 'px', modelId: 'mx' } }));
  const r2 = ensureZcodeModelConfig({ sessionId: 's2', cfgPath, rolloutDir: rollout, v2ConfigPath: v2 });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /provider px/);
});

test('ensureZcodeModelConfig：无 sessionId（setup 默认）选第一个自定义 provider', (t) => {
  const dir = tempDir(t);
  const cfgPath = path.join(dir, 'cli-config.json');
  const v2 = path.join(dir, 'v2-config.json');
  const rollout = path.join(dir, 'rollout');
  fs.mkdirSync(rollout, { recursive: true });
  fs.writeFileSync(v2, JSON.stringify({
    provider: {
      'builtin:zai': { name: 'zai', kind: 'openai', options: {}, models: { 'glm-5': {} } },
      'custom1': { name: 'c1', kind: 'anthropic', options: { apiKey: 'k', baseURL: 'u' }, models: { 'm-a': {}, 'm-b': {} } },
    },
  }));
  const r = ensureZcodeModelConfig({ cfgPath, rolloutDir: rollout, v2ConfigPath: v2 });
  assert.equal(r.ok, true);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.equal(cfg.model, 'custom1/m-a', '跳过 builtin，选第一个自定义 provider 的第一个模型');
});
