// 系统原生通知（跨平台）
// 桌面通知的默认路径：守护进程在跑 → 写请求文件由守护进程代发（hook 进程，尤其 ZCode，
// 退出时会被执行端口杀掉整棵进程树，fire-and-forget 的通知来不及渲染）；
// 守护进程不在 → 直接 spawn 弹通知（Claude Code / Codex / DSH 宿主进程常驻，可正常工作）。
// Windows 走 WinRT Toast（系统通知）：NotifyIcon.ShowBalloonTip 在 Windows 11 上经常
// 不显示（旧系统托盘机制已被系统通知层取代），WinRT Toast 后台进程可可靠显示并进入操作中心。
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DAEMON_JSON, NOTIFY_QUEUE_DIR, ensureDir } from './paths.mjs';

// WinRT Toast 脚本（Windows 10/11）：标题/正文经环境变量传入，规避 PowerShell
// 引号与 XML 转义问题。AppId 必须用已注册的 AUMID，否则 Win10 1903+ 会静默丢弃
// 通知——a4phone 未打包注册，因此借 PowerShell 的注册 AUMID 显示
// （taost 归属显示为 Windows PowerShell；这是 BurntToast 等库的通用做法）。
const WINDOWS_POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_TOAST_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
function Xml-Escape([string]\$value) {
  return \$value.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;').Replace("'",'&apos;')
}
\$title = Xml-Escape \$env:A4P_TOAST_TITLE
\$body = Xml-Escape \$env:A4P_TOAST_BODY
\$xmlDocument = [Windows.Data.Xml.Dom.XmlDocument]::new()
\$xmlDocument.LoadXml("<toast><visual><binding template='ToastGeneric'><text>\$title</text><text>\$body</text></binding></visual></toast>")
\$toast = [Windows.UI.Notifications.ToastNotification]::new(\$xmlDocument)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\$env:A4P_TOAST_APPID).Show(\$toast)`;

// 直接 spawn PowerShell 弹系统通知（低层原语，守护进程代发时用）
function showBalloon(title, message) {
  // 立即返回，不阻塞调用方
  const clean = (s) => (s || '').replace(/"/g, "'");
  if (process.platform === 'win32') {
    const child = spawn('powershell', ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST_SCRIPT], {
      env: {
        ...process.env,
        A4P_TOAST_APPID: WINDOWS_POWERSHELL_AUMID,
        A4P_TOAST_TITLE: String(title || '').slice(0, 64),
        A4P_TOAST_BODY: String(message || '').slice(0, 256),
      },
      // windowsHide 隐藏 PowerShell 控制台窗口（否则每次弹通知都会闪出一个黑窗）
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const t = clean(title);
  const m = clean(message);
  const child = process.platform === 'darwin'
    ? spawn('osascript', ['-e', `display notification "${m}" with title "${t}"`], { stdio: 'ignore' })
    : spawn('notify-send', [t, m], { stdio: 'ignore' });
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
