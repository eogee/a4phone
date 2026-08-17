// 系统原生通知（跨平台）
import { spawn } from 'child_process';
import path from 'node:path';

export function systemNotify(title, message) {
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
    ? spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), cmd, { stdio: 'ignore', detached: process.platform !== 'win32' })
    : process.platform === 'darwin'
      ? spawn('osascript', cmd, { stdio: 'ignore' })
      : spawn('notify-send', cmd, { stdio: 'ignore' });
  // 修复：spawn 失败会触发 unhandled 'error' 事件并导致宿主进程崩溃，
  // 必须挂 error 监听器让通知失败静默降级，而不是拖垮 dsh web。
  child.on('error', () => {});
  child.unref();
}
