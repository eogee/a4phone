// buildResumeArgs 单元测试：按最近会话的 agent 构建续聊命令
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeArgs, codexConflictReason, generateThreadId, forkCodexSession, commandAvailable } from '../src/resume.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('Claude Code 用 claude --resume --continue -p', () => {
  const { command, args } = buildResumeArgs('Claude Code', 'abc-123', 'C:/proj', 'C:/tmp/r.txt');
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['--resume', 'abc-123', '--continue', '-p']);
});

test('Codex 用 codex exec resume，-o 写回复文件、stdin 读消息（无 -C）', () => {
  const { command, args } = buildResumeArgs('Codex', '019fe96e-68a5', 'C:/Proj', 'C:/tmp/reply.txt');
  assert.equal(command, 'codex');
  assert.equal(args[0], 'exec');
  assert.equal(args[1], 'resume');
  assert.ok(args.includes('019fe96e-68a5'));              // 会话 ID
  assert.ok(!args.includes('-C'), 'codex exec resume 不接受 -C，cwd 由 spawn 层传入');
  assert.ok(!args.some((a) => a === 'C:/Proj'), '不应把 cwd 拼进参数');
  assert.equal(args[args.indexOf('-o') + 1], 'C:/tmp/reply.txt'); // 回复文件
  assert.equal(args[args.length - 1], '-');               // stdin 提示词
  assert.ok(args.includes('--dangerously-bypass-hook-trust'));
  assert.ok(args.includes('--skip-git-repo-check'));
});

test('Qoder 每轮 fork 到新会话（无会话锁，避免往活跃会话续写）', () => {
  const { command, args, newSessionId } = buildResumeArgs('Qoder', 'sess-qoder', 'C:/proj', 'C:/tmp/r.txt');
  assert.equal(command, 'qoder');
  assert.ok(!args.includes('--continue'), 'Qoder 拒绝 --resume 与 --continue 并用');
  assert.equal(args[0], '--resume');
  assert.equal(args[1], 'sess-qoder');
  assert.ok(args.includes('--fork-session'), '必须 fork，原会话不受影响');
  assert.equal(args[args.indexOf('--session-id') + 1], newSessionId, '新会话 ID 预生成，便于写回 last.json');
  assert.match(newSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(args[args.length - 1], '-p');
});

test('未知 agent 也按 claude 分支兜底（默认最近会话无 agent 字段）', () => {
  const { command, args } = buildResumeArgs(undefined, 'sess', 'C:/proj', 'C:/tmp/r.txt');
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['--resume', 'sess', '--continue', '-p']);
});

test('commandAvailable 区分 PATH 上有/没有的命令', () => {
  assert.equal(commandAvailable('node'), true);
  assert.equal(commandAvailable('a4p-no-such-command-xyz'), false);
  assert.equal(commandAvailable(''), false);
  assert.equal(commandAvailable(undefined), false);
});

test('codexConflictReason 识别 thread-store conflict 并给出可操作提示', () => {
  const err = 'ERROR codex_core::session: thread-store conflict: thread abc already has an active writer\nError: thread/resume failed (code -32600)';
  const reason = codexConflictReason(err);
  assert.ok(reason, '应识别出冲突');
  assert.ok(reason.includes('关闭那个 Codex 终端窗口'), '提示应告诉用户关窗口');
  assert.ok(!reason.includes('thread-store'), '不应泄漏原始错误文本');
});

test('codexConflictReason 对正常 stderr 返回 null', () => {
  assert.equal(codexConflictReason('OpenAI Codex v0.147.0\nhook: Stop Completed'), null);
  assert.equal(codexConflictReason(''), null);
});

test('generateThreadId 生成 codex 风格 ID（8-4-4-4-12 十六进制）', () => {
  const id = generateThreadId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(id, generateThreadId(), '两次生成不应相同');
});

test('forkCodexSession 复制会话为新线程 ID，原文件不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-fork-test-'));
  const oldId = '019fe9b9-9e29-7b53-bac3-b7018be1332d';
  const src = path.join(dir, `rollout-2026-08-10T11-31-24-${oldId}.jsonl`);
  const meta = JSON.stringify({ timestamp: '2026-08-10T03:31:24.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: oldId, id: oldId, timestamp: '2026-08-10T03:31:24.000Z' } });
  const evt = JSON.stringify({ timestamp: '2026-08-10T03:31:53Z', ordinal: 1, type: 'event_msg', payload: { thread_id: oldId, role: 'user', content: '你好' } });
  const srcContent = meta + '\n' + evt + '\n';
  fs.writeFileSync(src, srcContent);

  const fork = forkCodexSession({ sessionId: oldId, transcriptPath: src });

  assert.ok(fork, '应成功 fork');
  assert.match(fork.newId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(fork.newTranscriptPath), 'fork 文件应存在');
  assert.notEqual(fork.newTranscriptPath, src, 'fork 文件应与原文件不同名');

  // 原文件不被改动
  assert.equal(fs.readFileSync(src, 'utf-8'), srcContent, '原文件应原样保留');

  // fork 内容：旧 ID 全部替换为新 ID，session_meta 时间戳更新为现在
  const forkContent = fs.readFileSync(fork.newTranscriptPath, 'utf-8');
  assert.ok(!forkContent.includes(oldId), 'fork 里不应再出现旧线程 ID');
  assert.ok(forkContent.includes(fork.newId), 'fork 里应使用新线程 ID');
  const forkMeta = JSON.parse(forkContent.split('\n')[0]);
  assert.equal(forkMeta.payload.session_id, fork.newId);
  assert.equal(forkMeta.payload.id, fork.newId);
  assert.notEqual(forkMeta.payload.timestamp, '2026-08-10T03:31:24.000Z', '时间戳应更新为现在');
  assert.ok(fork.newTranscriptPath.startsWith(dir), 'fork 文件应与原文件同目录');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── WorkBuddy 明确不支持远程续聊 ─────────────────────────────────────
// 回归约束：WorkBuddy 的凭据只在桌面进程内存中，内置 CLI 必须交互式 /login，
// 无法 headless 续聊。必须给出明确原因，不能静默失败，也不能退化成
// "暂不支持 X 会话" 这种让用户以为功能坏了的笼统提示。
test('WorkBuddy 会话续聊返回明确原因而非笼统提示', async (t) => {
  // 必须隔离 last.json：runResume 读的是真实的 ~/.a4phone/last.json，
  // 若沿用用户上一次会话的 agent（ZCode/Codex/...），本用例会走错分支而误报。
  const { LAST_PATH } = await import('../src/config.mjs');
  const backup = fs.existsSync(LAST_PATH) ? fs.readFileSync(LAST_PATH, 'utf-8') : null;
  t.after(() => {
    try {
      if (backup) fs.writeFileSync(LAST_PATH, backup);
      else fs.unlinkSync(LAST_PATH);
    } catch {}
  });
  fs.writeFileSync(LAST_PATH, JSON.stringify({
    session_id: 'wb-test-001', cwd: 'C:/proj', agent: 'WorkBuddy', ts: Date.now(),
  }));

  const { runResume } = await import('../src/resume.mjs');
  const r = await runResume('继续');
  assert.equal(r.ok, false);
  assert.match(r.reason, /WorkBuddy/, '提示需指明是 WorkBuddy');
  assert.match(r.reason, /不支持/, '需明确说不支持');
  // 应告知其余三项能力正常，避免用户误以为整个集成都不能用
  assert.match(r.reason, /通知|提问/, '需说明其他能力仍可用');
});

test('buildResumeArgs 不为 WorkBuddy 生成命令（避免误入通用分支）', () => {
  // WorkBuddy 在runResume 里被提前拦下，不应走到 buildResumeArgs；
  // 若将来有人把它加进通用分支，这里会暴露（返回的 command 仍是 claude）
  const { command } = buildResumeArgs('WorkBuddy', 'sess-1', 'C:/proj', 'C:/tmp.txt');
  assert.notEqual(command, 'codebuddy', '不应为 WorkBuddy 生成 codebuddy 命令');
});
