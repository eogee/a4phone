// 安装引导：生成话题、写入配置、注册 Hook、显示二维码
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from './config.mjs';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// 生成唯一话题名
function generateTopic() {
  return 'a4p-' + crypto.randomBytes(8).toString('hex');
}

// 把 Hook 合并写入 settings.json（追加到各事件，保留用户既有 Hook）
// 返回 true=有写入，false=已存在相同配置跳过
export function registerHooks(settingsPath, hookCommand) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}

  settings.hooks = settings.hooks || {};

  const eventBlocks = {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand }] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
  };

  let changed = false;
  for (const [event, blocks] of Object.entries(eventBlocks)) {
    // 兼容既有配置：事件值可能是数组，也可能被手写成单个对象
    const list = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : settings.hooks[event] ? [settings.hooks[event]] : [];
    const alreadyConfigured = list.some((b) =>
      (b.hooks || []).some((h) => h.command === hookCommand)
    );
    if (alreadyConfigured) continue;
    list.push(...blocks);
    settings.hooks[event] = list;
    changed = true;
  }

  if (!changed) return false;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
}

export function unregisterHooks(settingsPath) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false; // 无 Hook 配置：不重写文件
  let changed = false;
  // 只移除 a4phone 的 Hook，保留用户的其他 Hook 与其他事件
  for (const event of Object.keys(hooks)) {
    const entry = hooks[event];
    const isA4p = (b) => (b.hooks || []).some((h) => (h.command || '').includes('a4p hook'));
    if (!Array.isArray(entry)) {
      // 手写的单对象条目（非数组）：仅当本身含 a4phone Hook 时才删除，否则原样保留
      if (entry && isA4p(entry)) { delete hooks[event]; changed = true; }
      continue;
    }
    const kept = entry.filter((b) => !isA4p(b));
    if (kept.length !== entry.length) changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (changed && Object.keys(hooks).length === 0) delete settings.hooks;
  if (!changed) return false; // 没有 a4phone 的 Hook：保持用户文件原样，不重写
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
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
matcher = "request_user_input"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "a4p hook codex"

[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "a4p hook codex"`;
}

// 修正既有配置里 a4phone PreToolUse 块的 matcher（Codex 的提问工具实际叫 request_user_input，
// 旧值 AskUserQuestion 匹配不上导致 hook 不触发）。只改含 a4p hook codex 的 PreToolUse 块。
export function fixCodexPreToolUseMatcher(content, oldMatcher, newMatcher) {
  const lines = content.split('\n');
  let i = 0;
  let changed = false;
  while (i < lines.length) {
    if (/^\[\[hooks\.PreToolUse\]\]\s*$/.test(lines[i])) {
      const block = [lines[i]];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        block.push(lines[j]);
        j++;
      }
      if (block.some((l) => l.includes('a4p hook codex'))) {
        const replaced = block.map((l) =>
          l.includes(`matcher = "${oldMatcher}"`)
            ? l.replace(`"${oldMatcher}"`, `"${newMatcher}"`)
            : l
        );
        if (replaced.some((l, k) => l !== block[k])) {
          lines.splice(i, block.length, ...replaced);
          changed = true;
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return changed ? lines.join('\n') : content;
}

// 写入 Codex 配置（保留既有内容，幂等）
// 追加到文件末尾，用显式表头包裹，避免根级键被吸收
export function configureCodex(codexPath = CODEX_PATH) {
  let content = '';
  try {
    content = fs.readFileSync(codexPath, 'utf-8');
  } catch {}
  // 已配置：marker 块存在，或 Codex 已把 a4phone Hook 规范化为内联格式
  if (content.includes(CODEX_MARKER_START) || /\ba4p hook codex\b/.test(content)) {
    // 顺带把旧 matcher 就地修正（Codex 提问工具名是 request_user_input）
    const fixed = fixCodexPreToolUseMatcher(content, 'AskUserQuestion', 'request_user_input');
    if (fixed !== content) fs.writeFileSync(codexPath, fixed);
    return false;
  }

  fs.mkdirSync(path.dirname(codexPath), { recursive: true });

  const defs = `${CODEX_MARKER_START}\n${codexHooksDefs()}\n${CODEX_MARKER_END}`;

  const featuresMatch = content.match(/^\[features\]\s*$/m);
  if (featuresMatch) {
    // 已有 [features] 表：仅当表内尚无 hooks 键时才插入 hooks = true，避免重复键
    const rest = content.slice(featuresMatch.index);
    const nextSection = rest.indexOf('\n[');
    const tableBody = nextSection === -1 ? rest : rest.slice(0, nextSection);
    if (!/^\s*hooks\s*=/m.test(tableBody)) {
      const insertAt = featuresMatch.index + '[features]'.length;
      content = content.slice(0, insertAt) + '\nhooks = true' + content.slice(insertAt);
    }
    fs.writeFileSync(codexPath, content.trimEnd() + '\n\n' + defs + '\n');
  } else {
    // 无 [features]：末尾追加完整块（[features] 显式表头 + Hook 定义）
    const block = `${CODEX_MARKER_START}\n[features]\nhooks = true\n\n${codexHooksDefs()}\n${CODEX_MARKER_END}`;
    fs.writeFileSync(codexPath, (content ? content.trimEnd() + '\n\n' : '') + block + '\n');
  }
  return true;
}

// 移除所有含 a4p hook codex 的 [[hooks.*]] 块（覆盖 marker 嵌套格式与 Codex 内联数组格式）
function stripA4pHookBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\[\[hooks\./.test(line)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        block.push(lines[j]);
        j++;
      }
      if (block.join('\n').includes('a4p hook codex')) {
        // a4phone 的 Hook 块：整块丢弃，并吞掉尾随空行
        while (j < lines.length && lines[j].trim() === '') j++;
      } else {
        out.push(...block);
      }
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

// 清理 configureCodex 写入的 [features] hooks = true 空壳：
// 仅当 [features] 表只剩下 hooks = true（移除后表变空）时才整表删除，
// 表里还有其他键时原样保留，避免误删用户自己的 features 配置。
export function stripFeaturesHooksShell(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\[features\]\s*$/.test(lines[i])) {
      // 收集表体直到下一个 [ 表头或文件末尾
      const body = [];
      let j = i + 1;
      while (j < lines.length && !/^\[/.test(lines[j])) {
        body.push(lines[j]);
        j++;
      }
      const keys = body.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const onlyHooksTrue = keys.length > 0 && keys.every((k) => k === 'hooks = true');
      if (onlyHooksTrue) {
        // 空壳：整表删除，顺带去掉前导空行
        i = j;
        while (out.length && out[out.length - 1].trim() === '') out.pop();
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

// 移除 Codex 配置中的 a4phone Hook（marker 块 + 规范化格式 + features 空壳）
export function unconfigureCodex(codexPath = CODEX_PATH) {
  let content = '';
  try {
    content = fs.readFileSync(codexPath, 'utf-8');
  } catch {}
  const original = content;
  const start = content.indexOf(CODEX_MARKER_START);
  const end = content.indexOf(CODEX_MARKER_END);
  if (start !== -1 && end !== -1) {
    content = content.slice(0, start) + content.slice(end + CODEX_MARKER_END.length);
  }
  const stripped = stripFeaturesHooksShell(stripA4pHookBlocks(content)).replace(/\n{3,}/g, '\n\n').trim();
  // 用原始内容判断是否发生变化：slice 后的 content 已不含 marker，与 stripped 恒等会误判"无需写入"
  if (stripped !== original.trim()) {
    fs.writeFileSync(codexPath, stripped + '\n');
  }
}

// ── DSH（DeepSeek Harness）Hook 插件挂载 ─────────────────────────────
// 复用本包 dsh/ 插件（Cordis 插件，监听 DSH 会话事件与工具/审批管线），
// 以 insert 形式追加到各 profile 的 cordis.patch.yml（热生效，无需重启）。
// profile 发现机制：扫描 ~/.dsh/profiles/ 下所有含 cordis.yml 的子目录
// （web / tui / dsh-tui 及后续新装的变体均可覆盖），插件 name 按各 profile
// 目录分别计算相对路径；守护进程（a4p listen）周期重扫，新装 profile 自动补挂。
const DSH_PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');
const DSH_MARKER_START = '# ===== a4phone dsh-hook (auto-generated) =====';
const DSH_MARKER_END = '# ===== end a4phone dsh-hook =====';

// 本包 dsh 插件入口文件绝对路径（setup.mjs 位于 src/，包根为 ../）
function dshPluginEntry() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh', 'lib', 'index.js');
}

// Windows 下把反斜杠路径转正斜杠（loader 按 URL 语义解析 name）
function toPosix(p) {
  return p.split(path.sep).join('/');
}

// 生成 dsh-hook 的 patch 挂载块（marker 包裹，便于幂等替换/清理）
function dshHookBlock(relName) {
  return `${DSH_MARKER_START}\n- insert:\n    - id: dsh-hook\n      name: "${relName}"\n${DSH_MARKER_END}`;
}

// 移除 cordis.patch.yml 中的 dsh-hook 挂载：
//   1) 本插件 marker 包裹的块；2) 任何顶层 insert 块（含旧版手动挂载 id: dsh-hook）。
// 保留 profile 头注释与其他插件条目。
function stripDshHookBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // marker 包裹的本插件块：整体移除（含 END 行）
    if (line.trim() === DSH_MARKER_START) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== DSH_MARKER_END) j++;
      i = Math.min(j + 1, lines.length);
      continue;
    }
    // 顶层 insert 块：缩进内容随块收集，含 id: dsh-hook 则整块丢弃并吞掉尾随空行
    if (/^- insert:\s*$/.test(line)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && /^\s/.test(lines[j])) { block.push(lines[j]); j++; }
      if (block.join('\n').includes('id: dsh-hook')) {
        while (j < lines.length && lines[j].trim() === '') j++;
      } else {
        out.push(...block);
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// 发现所有 DSH profile：profiles 目录下含 cordis.yml 的子目录
// （cordis.yml 是 profile 的身份文件；node_modules 等非 profile 目录自动排除）。
// 导出便于测试与守护进程复用。
export function discoverDshProfiles(profilesDir = DSH_PROFILES_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return []; // ~/.dsh/profiles 不存在：DSH 未安装
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => path.join(profilesDir, e.name))
    .filter((dir) => {
      try { return fs.existsSync(path.join(dir, 'cordis.yml')); } catch { return false; }
    });
}

// 单个 profile 的挂载写入（幂等）：返回 true=已写入，false=跳过（profile 不存在或已是最新）。
function mountDshHook({ profileDir, pluginEntry }) {
  if (!fs.existsSync(profileDir)) return false; // dsh 未初始化，跳过
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  let content = '';
  try { content = fs.readFileSync(patchPath, 'utf-8'); } catch {}

  // 已挂载本插件的最新相对路径 → 幂等跳过
  const rel = toPosix(path.relative(profileDir, pluginEntry));
  const block = dshHookBlock(rel);
  if (content.includes(DSH_MARKER_START) && content.includes(block)) return false;

  // 默认模板占位符 `[]` 本身就是一个完整的 YAML 文档；若原样保留再往后追加
  // 条目，文件会变成两个没有 `---` 分隔的文档，DSH 启动解析时报
  // "end of the stream or a document separator is expected"，故追加前移除。
  const base = stripDshHookBlocks(content)
    .replace(/^[ \t]*\[\][ \t]*\r?$/m, '')
    .trimEnd().replace(/\n{3,}/g, '\n\n');
  const out = (base ? base + '\n\n' : '') + block + '\n';
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(patchPath, out);
  return true;
}

// 写入 dsh-hook 挂载，两种模式：
//   - 显式传入 profileDir：仅处理该 profile，返回 boolean（兼容旧调用与单测）
//   - 未传 profileDir：扫描 ~/.dsh/profiles 下全部 profile，
//     返回 { scanned, mounted }（mounted 为本次新写入的 profile 名列表）
// 显式传入参数便于测试（沿用 configureCodex(codexPath) 的模式）。
export function configureDsh({ profileDir, profilesDir = DSH_PROFILES_DIR, pluginEntry = dshPluginEntry() } = {}) {
  if (profileDir) return mountDshHook({ profileDir, pluginEntry });
  const profiles = discoverDshProfiles(profilesDir);
  const mounted = [];
  for (const dir of profiles) {
    if (mountDshHook({ profileDir: dir, pluginEntry })) mounted.push(path.basename(dir));
  }
  return { scanned: profiles.length, mounted };
}

// 移除 dsh-hook 挂载（uninstall），同样支持两种模式：
//   - 显式传入 profileDir：仅清理该 profile，返回 boolean
//   - 未传：清理所有发现的 profile，任一改写即返回 true
export function unconfigureDsh({ profileDir, profilesDir = DSH_PROFILES_DIR } = {}) {
  const dirs = profileDir ? [profileDir] : discoverDshProfiles(profilesDir);
  let changed = false;
  for (const dir of dirs) {
    const patchPath = path.join(dir, 'cordis.patch.yml');
    if (!fs.existsSync(patchPath)) continue;
    const content = fs.readFileSync(patchPath, 'utf-8');
    const stripped = stripDshHookBlocks(content).replace(/\n{3,}/g, '\n\n').trim();
    if (stripped === content.trim()) continue; // 该 profile 无 a4phone dsh-hook 挂载
    fs.writeFileSync(patchPath, stripped ? stripped + '\n' : '');
    changed = true;
  }
  return changed;
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
  const dshResult = configureDsh();

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
  let dshStatus;
  if (!fs.existsSync(DSH_PROFILES_DIR)) {
    dshStatus = '未检测到 DSH 环境（~/.dsh/profiles），跳过';
  } else if (!dshResult.scanned) {
    dshStatus = '~/.dsh/profiles 下暂无 profile，跳过（新装 profile 后守护进程会自动补挂）';
  } else {
    const names = discoverDshProfiles().map((p) => path.basename(p));
    dshStatus = dshResult.mounted.length
      ? `已自动写入 cordis.patch.yml：${dshResult.mounted.join('、')}（共 ${names.length} 个 profile：${names.join('、')}）`
      : `已存在，跳过（共 ${names.length} 个 profile：${names.join('、')}）`;
  }
  process.stdout.write(`DSH 配置：${dshStatus}\n`);
  process.stdout.write('模式切换：a4p out（外出/手机优先） / a4p home（终端优先） / a4p status\n');
  process.stdout.write('重启 Claude Code / Codex 会话后 Hook 生效（DSH 插件热生效，无需重启）。\n');

  // 默认启动续聊守护进程 + 注册开机自启（失败不阻塞 setup，给出提示）
  try {
    const { startDaemon } = await import('./daemon.mjs');
    await startDaemon();
  } catch (error) {
    process.stdout.write(`续聊守护进程启动失败：${String(error?.message ?? error)}\n`);
  }
  try {
    const { enableAutostart } = await import('./autostart.mjs');
    const autostart = enableAutostart();
    process.stdout.write(autostart.ok
      ? '开机自启：已注册（登录时自动运行续聊守护进程，可用 a4p autostart --off 关闭）\n'
      : `开机自启：${autostart.reason}\n`);
  } catch (error) {
    process.stdout.write(`开机自启注册失败：${String(error?.message ?? error)}\n`);
  }
  return config;
}
