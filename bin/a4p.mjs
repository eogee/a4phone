#!/usr/bin/env node
// a4phone 命令行入口
//   a4p setup   安装引导（生成话题、注册 Hook、显示二维码）
//   a4p out     外出模式（手机优先）
//   a4p home    终端优先模式（默认）
//   a4p status  查看当前模式
//   a4p hook    处理 Claude Code Hook（内部调用）
//   a4p listen  启动续聊守护进程（后台 / --stop / --status）
//   a4p resume  手动续聊最近会话
//   a4p last    查看最近会话记录
//   a4p test    发送测试通知
//   a4p uninstall 移除 Hook 和配置
import fs from 'fs';
import path from 'path';
import os from 'os';
import qrcode from 'qrcode-terminal';
import { migrateLegacy, LOG_PATH, A4P_DIR } from '../src/paths.mjs';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// 把旧版家目录散点文件迁移到 ~/.a4phone/（幂等，无旧文件时仅建目录）
migrateLegacy();

function showHelp() {
  console.log('a4phone — Claude Code / Codex / DSH 远程手机交互\n');
  console.log('用法:');
  console.log('  a4p setup       安装引导（生成话题、注册 Hook、挂载 DSH 插件、显示二维码）');
  console.log('  a4p out         外出模式（手机优先）');
  console.log('  a4p home        终端优先模式（默认）');
  console.log('  a4p status      查看当前模式');
  console.log('  a4p listen      后台运行续聊守护进程（无窗口）');
  console.log('  a4p listen --stop    停止守护进程');
  console.log('  a4p listen --status  查看守护进程状态');
  console.log('  a4p resume      手动续聊最近会话：a4p resume 要追加的内容');
  console.log('  a4p last        查看最近会话记录');
  console.log('  a4p test        发送测试通知');
  console.log('  a4p uninstall   移除 Hook 和配置');
  console.log('  a4p --version   查看版本号');
  console.log('  a4p help        显示本帮助');
}

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(pkg.version);
} else if (cmd === 'setup') {
  const { runSetup } = await import('../src/setup.mjs');
  qrcode.setErrorLevel('L');
  await runSetup({ generateQR: (text, opts, cb) => qrcode.generate(text, opts, cb) });
} else if (cmd === 'out' || cmd === 'home') {
  const { setMode } = await import('../src/mode.mjs');
  setMode(cmd);
  console.log(cmd === 'out'
    ? '外出模式已开启：提问/权限请求优先推送手机，超时兜底终端。'
    : '终端优先模式：提问/权限请求直接走终端，手机不参与。');
} else if (cmd === 'status') {
  const { readMode } = await import('../src/mode.mjs');
  console.log(readMode() === 'out' ? '当前模式：外出（手机优先）' : '当前模式：终端优先（默认）');
} else if (cmd === 'hook') {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    process.exit(0);
  }
  // 可选的 agent 标识：a4p hook [codex|claude]，默认 claude
  const agent = process.argv[3] === 'codex' ? 'codex' : 'claude';
  const { dispatchHook } = await import('../src/hook.mjs');
  const result = await dispatchHook(input, agent);
  if (result) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} else if (cmd === 'uninstall') {
  const { unregisterHooks, unconfigureCodex, unconfigureDsh } = await import('../src/setup.mjs');
  const { stopDaemon } = await import('../src/daemon.mjs');
  // 先停守护进程：Windows 上守护进程持有 daemon.log 句柄，直接删目录会失败且异常被静默吞掉
  await stopDaemon();
  unregisterHooks(SETTINGS_PATH);
  unconfigureCodex();
  unconfigureDsh();
  // 新版 ~/.a4phone/ 目录 + 旧版家目录散点文件一并清理
  try { fs.rmSync(A4P_DIR, { recursive: true, force: true }); } catch {}
  for (const f of ['.a4phone.json', '.a4phone-mode.json', '.a4phone-last.json', '.a4phone-daemon.json', '.a4phone-daemon.log']) {
    try { fs.unlinkSync(path.join(os.homedir(), f)); } catch {}
  }
  console.log('a4phone 已卸载：Claude Code / Codex / DSH Hook 已移除，配置已删除。');
} else if (cmd === 'listen') {
  const sub = process.argv[3];
  if (sub === '--stop') {
    const { stopDaemon } = await import('../src/daemon.mjs');
    await stopDaemon();
  } else if (sub === '--status') {
    const { daemonStatus } = await import('../src/daemon.mjs');
    await daemonStatus();
  } else if (sub === '--daemon-child') {
    // 后台子进程：日志写入文件
    const { runListen, createLogWriter } = await import('../src/listen.mjs');
    const onLog = createLogWriter(LOG_PATH);
    await runListen({ onLog });
  } else {
    // 统一入口：a4p listen 即后台守护进程
    const { startDaemon } = await import('../src/daemon.mjs');
    await startDaemon();
  }
} else if (cmd === 'resume') {
  const { runResume } = await import('../src/resume.mjs');
  const text = process.argv.slice(3).join(' ');
  if (!text.trim()) {
    console.error('用法: a4p resume 要追加的内容');
    process.exit(1);
  }
  const result = await runResume(text);
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(`续聊完成（退出码 ${result.code}），结果已推送手机。`);
} else if (cmd === 'last') {
  const { loadLastSession } = await import('../src/config.mjs');
  const last = loadLastSession();
  if (!last) {
    console.log('暂无最近会话记录，完成一次任务后自动记录。');
  } else {
    console.log('最近会话:');
    console.log(`  会话 ID: ${last.session_id}`);
    console.log(`  目录:    ${last.cwd}`);
    console.log(`  来源:    ${last.agent}`);
    console.log(`  时间:    ${new Date(last.ts).toLocaleString()}`);
  }
} else if (cmd === 'test') {
  const { loadConfig } = await import('../src/config.mjs');
  const { sendNotification } = await import('../src/ntfy.mjs');
  const config = loadConfig();
  if (!config.topic) {
    console.error('未配置话题，请先运行 a4p setup。');
    process.exit(1);
  }
  const ok = await sendNotification({ ...config, title: 'a4phone', message: '测试通知：如果手机收到，配置正常。' });
  console.log(ok ? '测试通知发送成功。' : '发送失败，请检查网络。');
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  showHelp();
} else {
  showHelp();
}
