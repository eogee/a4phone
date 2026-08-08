// 续聊：把手机发来的文本作为下一条用户消息注入当前会话。
//   优先尝试实时注入（PowerShell 打字到正在运行的终端窗口），
//   失败则回退到 claude --resume --continue（非运行态可用）。
//   实时注入后轮询 transcript 提取 AI 回复推回手机。
import fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig, loadLastSession } from './config.mjs';
import { sendNotification } from './ntfy.mjs';
import { readMode, setMode } from './mode.mjs';
import { injectToTerminal } from './inject.mjs';
import { extractLastOutput } from './transcript.mjs';

const MAX_REPLY = 1000; // 回推输出截断长度
const INJECT_REPLY_TIMEOUT = 120000; // 实时注入后等待 AI 回复的最长时间（毫秒）
const INJECT_REPLY_POLL = 2000; // 轮询间隔

// 去除 ANSI 转义与空行，取末尾一段（Claude Code 非 TTY 下 stdout 尾部即最终回复）
function extractReply(output) {
  const clean = (output || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  if (!clean) return null;
  return clean.length > MAX_REPLY ? '...（输出较长已截断）\n' + clean.slice(-MAX_REPLY) : clean;
}

// 等待 claude 进程结束，返回 { ok, code, stdout, stderr, reason }
function spawnClaude({ args, cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    const useCmd = process.platform === 'win32';
    const command = useCmd ? 'cmd' : 'claude';
    const commandArgs = useCmd ? ['/c', 'claude', ...args] : args;
    let child;
    try {
      // A4P_RESUME 标记：让 Stop Hook 识别这是续聊子进程，避免重复推送"任务已完成"
      child = spawn(command, commandArgs, { cwd, shell: false, env: { ...process.env, A4P_RESUME: '1' } });
    } catch (err) {
      resolve({ ok: false, reason: `无法启动 claude：${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (useCmd) {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `无法启动 claude：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: true, code, stdout, stderr });
    });
    try {
      child.stdin.write(input + '\n');
      child.stdin.end();
    } catch {}
  });
}

// 实时注入：打字到终端后，轮询 transcript 等待 AI 产生新回复
async function waitForReply(transcriptPath, { timeoutMs, poll }) {
  if (!transcriptPath) return null;
  const start = Date.now();
  let lastText = '';
  while (Date.now() - start < timeoutMs) {
    const latest = extractLastOutput(transcriptPath);
    if (latest && latest !== lastText) {
      lastText = latest;
      // 给一点时间让回复稳定，再返回
      await new Promise((r) => setTimeout(r, poll));
      return latest;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  return lastText || null;
}

// 执行一次续聊，返回 { ok, reason?, code?, mode? }
export async function runResume(text, { config = null, agentName = 'Claude Code', onLog = (s) => {} } = {}) {
  config = config || loadConfig();
  if (!config.topic) return { ok: false, reason: '未配置话题，请先运行 a4p setup。' };

  const last = loadLastSession();
  if (!last?.session_id) return { ok: false, reason: '暂无最近会话，请先完成一次任务触发 Stop 事件。' };
  if (last.agent && last.agent !== 'Claude Code') {
    return { ok: false, reason: `续聊目前仅支持 Claude Code 会话（最近会话来自 ${last.agent}）。` };
  }
  const textClean = (text || '').trim();
  if (!textClean) return { ok: false, reason: '续聊内容为空。' };

  // 续聊期间锁定外出模式（人在手机端），结束后恢复原模式
  const prevMode = readMode();
  const lockedOut = prevMode !== 'out';
  if (lockedOut) setMode('out');

  const cwd = last.cwd && last.cwd !== '未知目录' ? last.cwd : process.cwd();

  // 1) 优先实时注入到正在运行的终端窗口
  const injected = await injectToTerminal(textClean, { windowPattern: config.windowPattern });
  if (injected.ok) {
    // 注入成功：轮询 transcript 等待 AI 回复并推回手机
    const reply = await waitForReply(last.transcript_path, {
      timeoutMs: INJECT_REPLY_TIMEOUT,
      poll: INJECT_REPLY_POLL,
    });
    await sendNotification({
      ...config,
      title: agentName,
      message: reply ? `${textClean}\n\n${reply}` : `消息已注入当前会话：${textClean}`,
    });
    if (lockedOut) setMode(prevMode);
    return { ok: true, mode: 'live', reply };
  }
  onLog(`实时注入失败（${injected.reason}），回退到 --resume`);

  // 2) 回退：--resume --continue（会话未运行时可注入并捕获回复）
  const proc = await spawnClaude({
    args: ['--resume', last.session_id, '--continue'],
    cwd,
    input: textClean,
    timeoutMs: config.resumeTimeout * 1000,
  });

  if (lockedOut) setMode(prevMode);

  if (!proc.ok) return { ok: false, reason: proc.reason };

  const reply = extractReply(proc.stdout) || extractReply(proc.stderr);
  const message = reply
    ? `续聊已完成（退出码 ${proc.code}）\n\n${reply}`
    : `续聊已完成（退出码 ${proc.code}，无文本输出）`;
  await sendNotification({ ...config, title: agentName, message });
  return { ok: true, code: proc.code };
}
