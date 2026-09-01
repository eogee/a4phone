// CodeBuddy（WorkBuddy 内置 CodeBuddy Code CLI）远程续聊支持：
//   WorkBuddy 桌面应用内置 cli/bin/codebuddy（CodeBuddy Code），支持
//   `codebuddy -p <text> --resume <sessionId> --output-format json` 的 headless 续聊，
//   --output-format json 输出 JSON 数组，取最后一个对象的 result 字段即回复。
//   hook 事件与 payload（hook_event_name / tool_name / tool_input）与 Claude Code 同构，
//   桌面弹窗 / 手机交互复用 a4phone 现有机制。
import fs from 'fs';
import path from 'path';
import os from 'os';

// 探测 CodeBuddy CLI（codebuddy）路径：WorkBuddy 内置 CLI / PATH 上的 codebuddy / cbc
export function findCodebuddyCli() {
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.push(path.join(local, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
    }
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy');
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// 构造 headless 续聊命令：codebuddy -p <text> --resume <id> --output-format json
// 纯函数，便于测试。cwd 由 spawn 的工作目录决定（CodeBuddy 无 --cwd 选项）。
export function buildCodebuddyArgs(text, sessionId, cliPath, extra = []) {
  return {
    command: process.execPath, // 直接用 node 可执行文件，避免 cmd /c 对参数引号的破坏
    args: [
      cliPath,
      '-p', text,
      '--resume', sessionId,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      ...extra,
    ],
  };
}

// 从 --output-format json 输出提取回复：输出为 JSON 数组，取最后一个对象的 result 字段
export function extractCodebuddyReply(stdout) {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = arr.length - 1; i >= 0; i--) {
      const result = arr[i]?.result;
      if (typeof result === 'string' && result.trim()) return result.trim();
    }
  } catch {}
  return null;
}
