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
// 返回 true=新写入，false=已存在跳过
export function registerHooks(settingsPath, hookCommand) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}

  // 已配置相同 Hook 则跳过
  const existing = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command;
  if (existing === hookCommand) return false;

  settings.hooks = {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand }] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
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

// Codex 配置路径与 a4phone 标记
const CODEX_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_MARKER_START = '# ===== a4phone hooks (auto-generated) =====';
const CODEX_MARKER_END = '# ===== end a4phone hooks =====';

// 生成 Codex 的 Hook 定义（数组嵌套表格，根级别）
// 命令带 codex 标识，便于 a4phone 动态显示触发方名称
function codexHooksDefs() {
  return `[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "a4p hook codex"

[[hooks.PreToolUse]]
matcher = "AskUserQuestion"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "a4p hook codex"

[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "a4p hook codex"`;
}

// 写入 Codex 配置（保留既有内容，幂等）
// 追加到文件末尾，用显式表头包裹，避免根级键被吸收
export function configureCodex() {
  let content = '';
  try {
    content = fs.readFileSync(CODEX_PATH, 'utf-8');
  } catch {}
  if (content.includes(CODEX_MARKER_START)) return false; // 已配置

  fs.mkdirSync(path.dirname(CODEX_PATH), { recursive: true });

  const defs = `${CODEX_MARKER_START}\n${codexHooksDefs()}\n${CODEX_MARKER_END}`;

  if (/^\[features\]\s*$/m.test(content)) {
    // 已有 [features] 表：把 hooks = true 插入该表，末尾追加 Hook 定义
    content = content.replace(/^\[features\]\s*$/m, '[features]\nhooks = true');
    fs.writeFileSync(CODEX_PATH, content.trimEnd() + '\n\n' + defs + '\n');
  } else {
    // 无 [features]：末尾追加完整块（[features] 显式表头 + Hook 定义）
    const block = `${CODEX_MARKER_START}\n[features]\nhooks = true\n\n${codexHooksDefs()}\n${CODEX_MARKER_END}`;
    fs.writeFileSync(CODEX_PATH, (content ? content.trimEnd() + '\n\n' : '') + block + '\n');
  }
  return true;
}

// 移除 Codex 配置中的 a4phone Hook 段
export function unconfigureCodex() {
  let content = '';
  try {
    content = fs.readFileSync(CODEX_PATH, 'utf-8');
  } catch {}
  const start = content.indexOf(CODEX_MARKER_START);
  const end = content.indexOf(CODEX_MARKER_END);
  if (start !== -1 && end !== -1) {
    content = content.slice(0, start) + content.slice(end + CODEX_MARKER_END.length);
    content = content.replace(/\n{3,}/g, '\n\n').trim();
    fs.writeFileSync(CODEX_PATH, content + '\n');
  }
}

// setup 主流程
export async function runSetup({ generateQR }) {
  const config = loadConfig();
  if (!config.topic) {
    config.topic = generateTopic();
    config.server = config.server || 'https://ntfy.sh';
  }
  saveConfig(config);

  const claudeConfigured = registerHooks(SETTINGS_PATH, hookCommand());
  const codexConfigured = configureCodex();

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
  process.stdout.write(`Claude Code 配置：${claudeConfigured ? '已自动写入 ~/.claude/settings.json' : '已存在，跳过'}\n`);
  process.stdout.write(`Codex 配置：${codexConfigured ? '已自动写入 ~/.codex/config.toml' : '已存在，跳过'}\n`);
  process.stdout.write('模式切换：a4p out（外出/手机优先） / a4p home（终端优先） / a4p status\n');
  process.stdout.write('重启 Claude Code / Codex 会话后 Hook 生效。\n');
  return config;
}
