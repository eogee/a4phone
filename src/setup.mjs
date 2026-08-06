// 安装引导：生成话题、写入配置、注册 Hook、显示二维码
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, saveConfig } from './config.mjs';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// 生成唯一话题名
function generateTopic() {
  return 'a4p-' + crypto.randomBytes(8).toString('hex');
}

// 把 Hook 合并写入 settings.json（保留既有配置）
export function registerHooks(settingsPath, hookCommand) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}

  settings.hooks = {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand }] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function unregisterHooks(settingsPath) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}
  delete settings.hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// 计算 Hook 命令：依赖全局安装的 a4p（在 PATH 上），路径更稳
function hookCommand() {
  return 'a4p hook';
}

// setup 主流程
export async function runSetup({ generateQR }) {
  const config = loadConfig();
  if (!config.topic) {
    config.topic = generateTopic();
    config.server = config.server || 'https://ntfy.sh';
  }
  saveConfig(config);

  registerHooks(SETTINGS_PATH, hookCommand());

  const subscribeUrl = `${config.server}/${config.topic}`;
  const ntfyUrl = `ntfy://${new URL(config.server).host}/${config.topic}`;

  process.stdout.write('a4phone 安装完成\n\n');
  process.stdout.write(`话题名称: ${config.topic}\n`);
  process.stdout.write(`订阅地址: ${subscribeUrl}\n\n`);

  if (generateQR) {
    process.stdout.write('在 ntfy App 中扫码订阅：\n\n');
    generateQR(ntfyUrl, { small: true }, (qr) => process.stdout.write(qr + '\n'));
  }

  process.stdout.write('\n在 ntfy App 添加订阅，输入话题名称或扫描上方二维码。\n');
  process.stdout.write('模式切换：a4p out（外出/手机优先） / a4p home（终端优先） / a4p status\n');
  process.stdout.write('重启 Claude Code 会话后 Hook 生效。\n');
  return config;
}
