// codebuddy.mjs 单元测试：CLI 参数构造、回复提取、CLI 路径探测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCodebuddyCli,
  buildCodebuddyArgs,
  extractCodebuddyReply,
} from '../src/codebuddy.mjs';

test('buildCodebuddyArgs 构造 headless 续聊命令', () => {
  const { command, args } = buildCodebuddyArgs('帮我总结', '550e8400-e29b-41d4-a716-446655440000', 'C:/codebuddy');
  assert.equal(command, process.execPath, '直接用 node 可执行文件（绕过 cmd /c 引号问题）');
  assert.equal(args[0], 'C:/codebuddy');
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('-p') + 1], '帮我总结');
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], '550e8400-e29b-41d4-a716-446655440000');
  assert.ok(args.includes('--output-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('extractCodebuddyReply 从 --output-format json 输出提取回复（取最后一个 result）', () => {
  const out = JSON.stringify([
    { type: 'progress' },
    { result: '第一个' },
    { result: '最终回复', session_id: 'x', duration_ms: 100 },
  ]);
  assert.equal(extractCodebuddyReply(out), '最终回复', '取最后一个含 result 的对象');
  assert.equal(extractCodebuddyReply(JSON.stringify({ result: '单对象' })), '单对象', '单对象也支持');
  assert.equal(extractCodebuddyReply('not json'), null);
  assert.equal(extractCodebuddyReply(''), null);
  assert.equal(extractCodebuddyReply(JSON.stringify([{ session_id: 'x' }])), null, '无 result 返回 null');
});

test('findCodebuddyCli 返回字符串路径或 null（不抛异常）', () => {
  const cli = findCodebuddyCli();
  assert.ok(cli === null || typeof cli === 'string', '应返回路径字符串或 null');
});
