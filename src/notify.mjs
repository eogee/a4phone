// 系统原生通知（跨平台）
// 桌面通知的默认路径：守护进程在跑 → 写请求文件由守护进程代发（hook 进程，尤其 ZCode，
// 退出时会被执行端口杀掉整棵进程树，fire-and-forget 的气泡来不及渲染）；
// 守护进程不在 → 直接 spawn 弹气泡（Claude Code / Codex / DSH 宿主进程常驻，可正常工作）。
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DAEMON_JSON, NOTIFY_QUEUE_DIR, ensureDir } from './paths.mjs';

// 直接 spawn PowerShell 弹气泡（低层原语，守护进程代发时用）
function showBalloon(title, message) {
  // 立即返回，不阻塞调用方
  const clean = (s) => (s || '').replace(/"/g, "'");
  const t = clean(title);
  const m = clean(message);
  let cmd;
  if (process.platform === 'win32') {
    // Windows：NotifyIcon 气泡通知（非阻塞，后台显示 3 秒）
    cmd = [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(3000,"${t}","${m}",[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep 3; $n.Dispose()`,
    ];
  } else if (process.platform === 'darwin') {
    cmd = ['-e', `display notification "${m}" with title "${t}"`];
  } else {
    cmd = [t, m];
  }
  const child = process.platform === 'win32'
    // windowsHide 隐藏 PowerShell 控制台窗口（否则每次弹气泡都会闪出一个黑窗）
    ? spawn('powershell', cmd, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    : process.platform === 'darwin'
      ? spawn('osascript', cmd, { stdio: 'ignore' })
      : spawn('notify-send', cmd, { stdio: 'ignore' });
  child.unref();
}

// 守护进程是否在运行（读 daemon.json 的 pid 探测存活）
export function isDaemonRunning() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf-8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 写入通知请求队列（守护进程代发；hook 进程退出后请求文件不受影响）
export function queueNotify(title, message, queueDir = NOTIFY_QUEUE_DIR) {
  try {
    ensureDir();
    fs.mkdirSync(queueDir, { recursive: true });
    const name = `notify-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
    const file = path.join(queueDir, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ title, message, ts: Date.now() }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// 处理通知队列（守护进程周期调用）：未过期的请求弹气泡并删除，损坏/过期文件直接丢弃。
// show 可注入以便测试。
export function processNotifyQueue({ queueDir = NOTIFY_QUEUE_DIR, show = showBalloon, ttlMs = 60_000 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(queueDir, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在：无事可做
  }
  let processed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(queueDir, entry.name);
    let req;
    try {
      req = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      try { fs.unlinkSync(file); } catch {} // 损坏文件：删除
      continue;
    }
    if (typeof req.title !== 'string' || typeof req.message !== 'string') {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    if (Date.now() - (Number(req.ts) || 0) > ttlMs) {
      // 守护进程停运期间积压的过期通知：丢弃，避免恢复后批量轰炸
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    try {
      show(req.title, req.message);
      processed++;
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return processed;
}

// 桌面通知入口（供 hook / DSH 插件调用）
export function systemNotify(title, message) {
  if (isDaemonRunning()) {
    queueNotify(title, message);
  } else {
    showBalloon(title, message);
  }
}
