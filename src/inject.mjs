// 实时注入：用 PowerShell 把手机消息"打字"到正在运行的 Claude Code 终端窗口。
//   实验性方案：依赖 Windows 控制台 API（AppActivate + 剪贴板粘贴）。
//   限制：需要终端窗口标题能匹配到、需前台焦点、无法直接捕获 AI 回复文本。
//   用 -EncodedCommand 以 base64-UTF16LE 传递整个命令，规避中文/引号转义问题。
import { execFile } from 'child_process';

// 默认匹配窗口标题含此关键字的终端（可在 config 中覆盖）
const DEFAULT_PATTERN = 'claude code';

export function injectToTerminal(text, { windowPattern = DEFAULT_PATTERN } = {}) {
  return new Promise((resolve) => {
    // 用 base64 传递文本，避免中文/特殊字符经命令行编码损坏
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    // 用剪贴板粘贴（Ctrl+V）而非 SendKeys，可靠支持中文/Unicode
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$b64 = '${b64}'
$msg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
[System.Windows.Forms.Clipboard]::SetText($msg)
$wshell = New-Object -ComObject wscript.shell
$ok = $wshell.AppActivate('${windowPattern}')
if (-not $ok) { Write-Error 'NO_WINDOW_MATCH'; exit 1 }
Start-Sleep -Milliseconds 300
$wshell.SendKeys('^v')
Start-Sleep -Milliseconds 200
$wshell.SendKeys('{ENTER}')
`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const reason = (stderr || '').trim() || err.message;
          resolve({ ok: false, reason: /NO_WINDOW_MATCH/.test(reason) ? '未找到匹配的终端窗口' : reason });
        } else {
          resolve({ ok: true });
        }
      }
    );
  });
}