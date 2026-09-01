// 续聊：把手机发来的文本作为下一条用户消息，续聊当前会话并回推回复
//   Claude Code：claude --resume <id> --continue -p（headless，stdin 作为消息、stdout 捕获回复）
//   Codex：codex exec resume <id> -o <文件> -（headless，stdin 作为消息、-o 把最后一条回复写入文件）
//   DSH：经 ~/.a4phone/dsh-jobs 文件队列交给 dsh web 进程内的 dsh-hook 插件，
//        插件直接 followup 到当前 live 会话（手机消息与回复实时出现在桌面会话里）
//   若 Codex 会话被窗口占用（thread-store conflict），自动 fork 成新线程续聊，无需关闭原窗口
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { loadConfig, loadLastSession, saveLastSession } from './config.mjs';
import { sendNotification } from './ntfy.mjs';
import { readMode, setMode } from './mode.mjs';

const MAX_REPLY = 1000; // 回推输出截断长度

// 去除 ANSI 转义与空行，取末尾一段（headless 模式输出尾部即最终回复）
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

// 按最近会话的 agent 构建续聊命令（纯函数，便于测试）
export function buildResumeArgs(agent, sessionId, cwd, replyFile) {
  if (agent === 'Codex') {
    // codex exec resume 不接受 -C（工作目录存在会话里），仅由 spawn 的 cwd 决定启动目录
    return {
      command: 'codex',
      args: [
        'exec', 'resume',
        '--dangerously-bypass-hook-trust', // 自动化场景：hook 信任已由用户确认，避免信任失效导致 exec 中断
        '--skip-git-repo-check',
        '-o', replyFile, // 最后一条回复写入该文件
        sessionId,
        '-', // 提示词从 stdin 读取
      ],
    };
  }
  return { command: 'claude', args: ['--resume', sessionId, '--continue', '-p'] };
}

// Codex 续聊独占约束：会话仍被其他进程持有写锁时，给出可操作的提示（而非裸错误文本）
export function codexConflictReason(stderr) {
  const s = stderr || '';
  if (/thread-store conflict|already has an active writer/.test(s)) {
    return '续聊未执行：该 Codex 会话仍被占用（对应的 Codex 窗口还开着，会话持有独占锁）。\n' +
      '请先关闭那个 Codex 终端窗口，让会话释放锁，再从手机重新发送消息。';
  }
  return null;
}

// 生成近似 codex 线程 ID 格式的随机 ID（32 位十六进制按 8-4-4-4-12 连字符）
export function generateThreadId() {
  const hex = crypto.randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 定位会话的 rollout 文件：优先用记录路径，兜底扫描 ~/.codex/sessions/**/rollout-*-<id>.jsonl
function findCodexRollout(sessionId, transcriptPath) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const base = path.join(os.homedir(), '.codex', 'sessions');
  try {
    for (const year of fs.readdirSync(base)) {
      const yDir = path.join(base, year);
      if (!fs.statSync(yDir).isDirectory()) continue;
      for (const month of fs.readdirSync(yDir)) {
        const mDir = path.join(yDir, month);
        if (!fs.statSync(mDir).isDirectory()) continue;
        for (const day of fs.readdirSync(mDir)) {
          const dDir = path.join(mDir, day);
          if (!fs.statSync(dDir).isDirectory()) continue;
          for (const f of fs.readdirSync(dDir)) {
            if (f.includes(sessionId) && f.endsWith('.jsonl')) {
              const p = path.join(dDir, f);
              if (fs.existsSync(p)) return p;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

// fork Codex 会话：复制 rollout 文件为新线程 ID（不建写锁），返回新会话信息；失败返回 null
//   - 原会话（含原窗口）毫发无损，可继续使用
//   - 手机续聊在 fork 上继续，多轮对话天然成立
export function forkCodexSession({ sessionId, transcriptPath }) {
  const src = findCodexRollout(sessionId, transcriptPath);
  if (!src) return null;
  const newId = generateThreadId();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dst = path.join(path.dirname(src), `rollout-${ts}-${newId}.jsonl`);
  let content;
  try {
    content = fs.readFileSync(src, 'utf-8');
  } catch {
    return null;
  }
  // 替换所有旧线程 ID，并把 session_meta 时间戳更新为现在（使其成为最新会话）
  const replaced = content.split(sessionId).join(newId);
  const lines = replaced.split('\n');
  if (lines[0]) {
    try {
      const meta = JSON.parse(lines[0]);
      if (meta.type === 'session_meta' && meta.payload) {
        meta.payload.timestamp = now.toISOString();
        lines[0] = JSON.stringify(meta);
      }
    } catch {}
  }
  try {
    fs.writeFileSync(dst, lines.join('\n'));
  } catch {
    return null;
  }
  return { newId, newTranscriptPath: dst };
}

// 等待 CLI 进程结束，返回 { ok, code, stdout, stderr, reason, timedOut }
// opts.wrapCmd=false：直接 spawn command（Windows 下跳过 cmd /c 包装，避免参数引号被破坏）
// opts.writeStdin=false：不写 stdin（如 ZCode 用 --prompt 传消息）
function spawnCli({ command, args, cwd, input, timeoutMs }, opts = {}) {
  return new Promise((resolve) => {
    const wrapCmd = opts.wrapCmd !== false && process.platform === 'win32';
    // 用 ComSpec 全路径启动 cmd，避免依赖 PATH 里能找到 cmd（沙箱/受限环境可能没有）
    const cmd = wrapCmd ? process.env.ComSpec || 'cmd' : command;
    const cmdArgs = wrapCmd ? ['/c', command, ...args] : args;
    let child;
    try {
      // A4P_RESUME 标记：让 Stop Hook 识别这是续聊子进程，避免重复推送"任务已完成"
      child = spawn(cmd, cmdArgs, { cwd, shell: false, env: { ...process.env, A4P_RESUME: '1' } });
    } catch (err) {
      resolve({ ok: false, reason: `无法启动 ${command}：${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
        spawn(taskkill, ['/pid', String(child.pid), '/f', '/t']).on('error', () => child.kill());
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `无法启动 ${command}：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: true, code, stdout, stderr, timedOut });
    });
    if (opts.writeStdin !== false && input != null) {
      try {
        child.stdin.write(input + '\n');
        child.stdin.end();
      } catch {}
    }
  });
}

// ZCode 续聊：headless 调 zcode CLI 续聊指定会话，回推回复到手机
async function runZcodeResume(text, { config, onLog, last }) {
  const { findZcodeCli, ensureZcodeModelConfig, buildZcodeArgs, extractZcodeReply } = await import('./zcode.mjs');

  const cliPath = findZcodeCli();
  if (!cliPath) {
    return { ok: false, reason: '未找到 ZCode CLI（zcode.cjs），请确认 ZCode 桌面端已安装。' };
  }

  // 同步会话当前模型到 cli/config.json（桌面端切换模型后，续聊跟随会话实际模型）
  const synced = ensureZcodeModelConfig({ sessionId: last.session_id });
  if (!synced.ok) {
    onLog(`ZCode 模型配置同步失败：${synced.reason}`);
    return { ok: false, reason: `ZCode 模型配置同步失败：${synced.reason}` };
  }

  const cwd = last.cwd && last.cwd !== '未知目录' ? last.cwd : process.cwd();
  const { command, args } = buildZcodeArgs(text, last.session_id, cwd, cliPath);
  const proc = await spawnCli({ command, args, cwd, timeoutMs: config.resumeTimeout * 1000 }, { wrapCmd: false, writeStdin: false });

  if (!proc.ok) return { ok: false, reason: proc.reason };

  let reply = extractZcodeReply(proc.stdout) || extractReply(proc.stdout) || extractReply(proc.stderr);
  let message;
  if (proc.timedOut) {
    onLog(`续聊超时（超过 ${config.resumeTimeout} 秒）已中断`);
    message = reply
      ? `续聊超时已中断（以下为超时前已生成的回复）\n\n${reply}`
      : `续聊超时，未获取到回复。`;
  } else {
    message = reply
      ? `续聊已完成（退出码 ${proc.code}）\n\n${reply}`
      : `续聊已完成（退出码 ${proc.code}，无文本输出）`;
  }
  await sendNotification({ ...config, title: 'ZCode', message });
  return { ok: true, code: proc.code };
}

// 执行一次续聊，返回 { ok, reason?, code? }
export async function runResume(text, { config = null, onLog = (s) => {} } = {}) {
  config = config || loadConfig();
  if (!config.topic) return { ok: false, reason: '未配置话题，请先运行 a4p setup。' };

  const last = loadLastSession();
  if (!last?.session_id) return { ok: false, reason: '暂无最近会话，请先完成一次任务触发 Stop 事件。' };
  const agent = last.agent || 'Claude Code';

  // DSH 续聊：不另起进程，而是把消息交给 dsh web 进程内的插件，
  // 直接 followup 到当前 live 会话（手机消息与回复都实时出现在桌面会话里）。
  if (agent === 'DSH') {
    const { runDshResume } = await import('./dsh-resume.mjs');
    // 续聊期间锁定外出模式（人在手机端），结束后恢复原模式
    const prevMode = readMode();
    const lockedOut = prevMode !== 'out';
    if (lockedOut) setMode('out');
    try {
      return await runDshResume(text, { config, onLog });
    } finally {
      if (lockedOut) setMode(prevMode);
    }
  }

  if (agent !== 'Claude Code' && agent !== 'Codex' && agent !== 'ZCode') {
    return { ok: false, reason: `续聊暂不支持 ${agent} 会话。` };
  }
  const textClean = (text || '').trim();
  if (!textClean) return { ok: false, reason: '续聊内容为空。' };

  // ZCode 续聊：headless 调用 zcode CLI（--prompt/--resume），
  // 续聊前自动同步会话当前模型到 ~/.zcode/cli/config.json（桌面端切换模型后跟随）。
  if (agent === 'ZCode') {
    const prevMode = readMode();
    const lockedOut = prevMode !== 'out';
    if (lockedOut) setMode('out');
    try {
      return await runZcodeResume(textClean, { config, onLog, last });
    } finally {
      if (lockedOut) setMode(prevMode);
    }
  }

  // 续聊期间锁定外出模式（人在手机端），结束后恢复原模式
  const prevMode = readMode();
  const lockedOut = prevMode !== 'out';
  if (lockedOut) setMode('out');

  const cwd = last.cwd && last.cwd !== '未知目录' ? last.cwd : process.cwd();
  let sessionId = last.session_id;
  let transcriptPath = last.transcript_path;
  let replyFile = path.join(os.tmpdir(), `a4p-reply-${process.pid}-${Date.now()}.txt`);
  let { command, args } = buildResumeArgs(agent, sessionId, cwd, replyFile);

  let proc = await spawnCli({
    command,
    args,
    cwd,
    input: textClean,
    timeoutMs: config.resumeTimeout * 1000,
  });

  // Codex 会话被窗口占用（thread-store conflict）时自动 fork 续聊：不关窗口也能续聊
  //   原会话（含原窗口）毫发无损；手机续聊在 fork 上继续，多轮对话天然成立
  let forked = false;
  if (proc.ok && command === 'codex' && codexConflictReason(proc.stderr)) {
    const fork = forkCodexSession({ sessionId, transcriptPath });
    if (fork) {
      forked = true;
      sessionId = fork.newId;
      transcriptPath = fork.newTranscriptPath;
      onLog(`Codex 会话被占用，已 fork 为新会话 ${fork.newId.slice(0, 8)} 继续续聊（原窗口不受影响）`);
      saveLastSession({ session_id: fork.newId, cwd, agent: 'Codex', transcript_path: fork.newTranscriptPath });
      try { fs.unlinkSync(replyFile); } catch {}
      replyFile = path.join(os.tmpdir(), `a4p-reply-${process.pid}-${Date.now()}.txt`);
      ({ command, args } = buildResumeArgs(agent, fork.newId, cwd, replyFile));
      proc = await spawnCli({
        command,
        args,
        cwd,
        input: textClean,
        timeoutMs: config.resumeTimeout * 1000,
      });
    }
  }

  if (lockedOut) setMode(prevMode);

  if (!proc.ok) return { ok: false, reason: proc.reason };

  // 回复来源：Codex 用 -o 写入的文件（若已生成），其余走 stdout 尾部
  let reply = extractReply(proc.stdout) || extractReply(proc.stderr);
  if (command === 'codex') {
    try {
      const fileReply = fs.readFileSync(replyFile, 'utf-8');
      reply = extractReply(fileReply) || reply;
    } catch {}
  }
  try { fs.unlinkSync(replyFile); } catch {}

  const name = agent === 'Codex' ? 'Codex' : 'Claude Code';
  let message;
  const conflict = command === 'codex' && !forked ? codexConflictReason(proc.stderr) : null;
  if (conflict) {
    onLog('续聊失败：Codex 会话仍被占用（独占锁未释放）');
    message = conflict;
  } else if (proc.timedOut) {
    onLog(`续聊超时（超过 ${config.resumeTimeout} 秒）已中断`);
    message = reply
      ? `续聊超时已中断（以下为超时前已生成的回复）\n\n${reply}`
      : `续聊超时，未获取到回复。`;
  } else {
    message = reply
      ? `续聊已完成（退出码 ${proc.code}）\n\n${reply}`
      : `续聊已完成（退出码 ${proc.code}，无文本输出）`;
  }
  await sendNotification({ ...config, title: name, message });
  return { ok: true, code: proc.code };
}
