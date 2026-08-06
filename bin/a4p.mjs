#!/usr/bin/env node
// a4phone 命令行入口
//   a4p setup   安装引导（生成话题、注册 Hook、显示二维码）
//   a4p out     外出模式（手机优先）
//   a4p home    终端优先模式（默认）
//   a4p status  查看当前模式
//   a4p hook    处理 Claude Code Hook（内部调用）
//   a4p uninstall 移除 Hook 和配置
import fs from 'fs';
import path from 'path';
import os from 'os';
import qrcode from 'qrcode-terminal';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const cmd = process.argv[2];

if (cmd === 'setup') {
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
  const { dispatchHook } = await import('../src/hook.mjs');
  const result = await dispatchHook(input);
  if (result) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} else if (cmd === 'uninstall') {
  const { unregisterHooks } = await import('../src/setup.mjs');
  unregisterHooks(SETTINGS_PATH);
  try { fs.unlinkSync(path.join(os.homedir(), '.a4phone.json')); } catch {}
  try { fs.unlinkSync(path.join(os.homedir(), '.a4phone-mode.json')); } catch {}
  console.log('a4phone 已卸载：Hook 已移除，配置已删除。');
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
} else {
  console.log('a4phone — Claude Code 远程手机交互\n');
  console.log('用法:');
  console.log('  a4p setup       安装引导（生成话题、注册 Hook）');
  console.log('  a4p out         外出模式（手机优先）');
  console.log('  a4p home        终端优先模式（默认）');
  console.log('  a4p status      查看当前模式');
  console.log('  a4p test        发送测试通知');
  console.log('  a4p uninstall   移除 Hook 和配置');
}
