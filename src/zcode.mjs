// ZCode 远程续聊支持（headless）：
//   桌面端 ZCode 自带 CLI（resources/glm/zcode.cjs），支持
//   `--prompt <text> --resume <sessionId> --json --mode yolo` 的 headless 续聊，
//   `--json` 输出 { sessionId, response, ... }，response 即回复文本。
//   前提：~/.zcode/cli/config.json 里要有显式模型配置（provider + model），
//   桌面 app 的模型/provider 注册表在 ~/.zcode/v2/config.json，不会同步过去。
//   因此每次续聊前从该会话的 rollout 记录读"实际使用的模型"，并从 v2 注册表
//   读取对应 provider 定义，同步写入 cli/config.json —— 保证桌面端切换模型后
//   续聊跟随的是会话当前模型，而不是写死的历史配置。
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZCODE_CLI_CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const ZCODE_V2_CONFIG = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const ZCODE_ROLLOUT_DIR = path.join(os.homedir(), '.zcode', 'cli', 'rollout');

// 探测 zcode CLI（zcode.cjs）路径：环境变量 / 常见安装位置；找不到返回 null
export function findZcodeCli() {
  const candidates = [];
  const fromEnv = process.env.ZCODE_WINDOWS_APP_INSTALL_DIR;
  if (fromEnv) candidates.push(path.join(fromEnv, 'resources', 'glm', 'zcode.cjs'));
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(path.join(local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// 从会话的 rollout 记录读该会话最近一次模型请求的 model 标识（"providerId/modelId"）
export function readSessionModel(sessionId, rolloutDir = ZCODE_ROLLOUT_DIR) {
  const file = path.join(rolloutDir, `model-io-sess_${sessionId}.jsonl`);
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  // modelRef 形如 {"providerId":"...","modelId":"..."}，取最后一次出现
  const re = /"modelRef":\s*\{[^{}]*"providerId":"([^"]+)","modelId":"([^"]+)"[^{}]*\}/g;
  let m;
  let found = null;
  while ((m = re.exec(content)) !== null) found = `${m[1]}/${m[2]}`;
  return found;
}

// 从 v2 注册表读 provider 定义（供 cli/config.json 使用：name/kind/options）
export function readProviderDef(providerId, v2ConfigPath = ZCODE_V2_CONFIG) {
  let v2;
  try {
    v2 = JSON.parse(fs.readFileSync(v2ConfigPath, 'utf-8'));
  } catch {
    return null;
  }
  const prov = v2?.provider?.[providerId];
  if (!prov || typeof prov !== 'object') return null;
  const def = { name: prov.name, kind: prov.kind, options: prov.options };
  return def.name && def.kind && def.options ? def : null;
}

// 确保 cli/config.json 的模型配置与会话实际模型一致（桌面端切换模型后自动跟随）。
// sessionId 省略时（a4p setup）写入默认配置：v2 注册表里第一个自定义 provider。
// 返回 { ok, reason? }
export function ensureZcodeModelConfig({ sessionId, cfgPath = ZCODE_CLI_CONFIG, rolloutDir = ZCODE_ROLLOUT_DIR, v2ConfigPath = ZCODE_V2_CONFIG } = {}) {
  let model = null;
  if (sessionId) {
    model = readSessionModel(sessionId, rolloutDir);
    if (!model) {
      // rollout 缺失（会话无模型请求记录，如异常结束/非桌面会话）：回退到现有配置，
      // 若完全没有模型配置则明确报错
      const existing = readJson(cfgPath);
      if (existing?.model) return { ok: true };
      return { ok: false, reason: '无法从 ZCode 会话记录确定模型（rollout 缺失），请先在桌面端运行该会话或重跑 a4p setup。' };
    }
  } else {
    // setup 默认：选第一个非 builtin 的自定义 provider 及其第一个模型
    let v2;
    try { v2 = JSON.parse(fs.readFileSync(v2ConfigPath, 'utf-8')); } catch { return { ok: false, reason: '未找到 ZCode 模型注册表（~/.zcode/v2/config.json）。' }; }
    const entries = Object.entries(v2?.provider || {});
    const custom = entries.find(([id]) => !id.startsWith('builtin:'));
    if (!custom) return { ok: false, reason: 'ZCode 注册表里没有可用的自定义 provider。' };
    const [providerId, prov] = custom;
    const modelId = Object.keys(prov?.models || {})[0];
    if (!modelId) return { ok: false, reason: `ZCode provider ${providerId} 没有可用的模型。` };
    model = `${providerId}/${modelId}`;
  }

  const providerId = model.split('/')[0];
  const cfg = readJson(cfgPath) || {};
  const hasProvider = cfg.provider?.[providerId] && typeof cfg.provider[providerId] === 'object';
  if (cfg.model === model && hasProvider) return { ok: true }; // 已一致

  const providerDef = readProviderDef(providerId, v2ConfigPath);
  if (!providerDef) return { ok: false, reason: `ZCode 注册表里找不到 provider ${providerId}（模型已切换或已删除？）。` };

  cfg.model = model;
  cfg.provider = { ...(cfg.provider || {}), [providerId]: providerDef };
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch (err) {
    return { ok: false, reason: `写入 ZCode 配置失败：${err.message}` };
  }
  return { ok: true };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// 构造 headless 续聊命令：node zcode.cjs --prompt <text> --resume <id> --json ...
// 纯函数，便于测试。注意：--max-turns 在 0.16.5 的帮助里有但解析器实际未实现
// （与 --settings 同为"文档先行"的选项），传入会被拒绝，故不使用。
export function buildZcodeArgs(text, sessionId, cwd, cliPath, extra = []) {
  return {
    command: process.execPath, // 直接用 node 可执行文件，避免 cmd /c 对参数引号的破坏
    args: [
      cliPath,
      '--prompt', text,
      '--resume', sessionId,
      '--json',
      '--mode', 'yolo',
      '--cwd', cwd,
      '--no-color',
      ...extra,
    ],
  };
}

// 从 headless 输出提取回复：--json 的 response 字段；解析失败返回 null
export function extractZcodeReply(stdout) {
  if (!stdout) return null;
  try {
    const obj = JSON.parse(stdout.trim());
    if (typeof obj?.response === 'string' && obj.response.trim()) return obj.response.trim();
  } catch {}
  return null;
}
