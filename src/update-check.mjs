// update-check.mjs — a4phone 版本更新检查
//
// 查询 npm registry 最新版本，与本地版本比对，发现新版本时提醒用户：
//   - 守护进程（a4p listen）：经 ntfy 推送手机提醒
//   - 其他命令（a4p status/setup/resume 等）：终端打印提示
//   - 缓存（~/.a4phone/update-cache.json）保证同一新版本只提醒一次 + 限频
//     （默认 6 小时查一次，避免每次命令都访问网络）
//   - registry 查询失败静默跳过（国内网络可能连不上，不影响正常功能）
//
// 纯函数（版本比对、缓存、到期判断）便于单元测试。
import fs from 'fs';
import { UPDATE_CACHE_PATH, ensureDir } from './paths.mjs';
import { sendNotification } from './ntfy.mjs';

/** 默认检查间隔（小时）：守护进程周期检查与命令级限频共用 */
export const DEFAULT_INTERVAL_HOURS = 6;

/** 查询源：国内镜像优先（与用户 npm 配置一致，国内网络更稳），官方兜底 */
const REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
];

/** 读取本地包版本号；读不到返回 '0.0.0' */
export function getLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 简单 semver 数值比较（无第三方依赖）：
 * compareVersions('1.2.10', '1.2.9') > 0
 * @param {string} a
 * @param {string} b
 * @returns {number} 1 | 0 | -1
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

/** 读取更新检查缓存；无/损坏返回空对象 */
export function loadCache(cachePath = UPDATE_CACHE_PATH) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return cache && typeof cache === 'object' ? cache : {};
  } catch {
    return {};
  }
}

/** 写缓存（原子写） */
export function saveCache(cache, cachePath = UPDATE_CACHE_PATH) {
  try {
    ensureDir();
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cachePath);
  } catch {}
}

/**
 * 查询 npm registry 最新版本号；全部源失败返回 null。
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchLatestVersion({ timeoutMs = 8000 } = {}) {
  for (const base of REGISTRIES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${base}/a4phone/latest`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (typeof data?.version === 'string' && data.version) return data.version;
    } catch {}
  }
  return null;
}

/**
 * 检查一次更新（含限频与提醒去重）。未到期/未开启/查询失败均静默跳过。
 * @param {object} [opts]
 * @param {object} [opts.config] a4phone 配置（checkUpdates=false 则跳过；updateIntervalHours 调整间隔）
 * @param {(latest:string)=>Promise<void>|void} [opts.notify] 发现新版本且未提醒过时的回调（推送/终端提示）
 * @param {(msg:string)=>void} [opts.onLog]
 * @param {number} [opts.now] 注入当前时间（测试用）
 * @param {string} [opts.cachePath] 注入缓存路径（测试用）
 * @param {number} [opts.minIntervalMs] 最小检查间隔（默认 updateIntervalHours 或 6 小时）
 * @param {string} [opts.localVersion] 注入本地版本（测试用）
 * @param {string|null} [opts.latestVersion] 注入最新版本（测试用；undefined 则实际查询，null 视为查询失败）
 * @returns {Promise<{checked:boolean, hasUpdate:boolean, local:string, latest:string|null, notified:boolean}>}
 */
export async function checkForUpdate({
  config = null,
  notify = null,
  onLog = () => {},
  now = Date.now(),
  cachePath = UPDATE_CACHE_PATH,
  minIntervalMs = null,
  localVersion = getLocalVersion(),
  latestVersion = undefined,
} = {}) {
  const cfg = config || {};
  if (cfg.checkUpdates === false) {
    return { checked: false, hasUpdate: false, local: localVersion, latest: null, notified: false };
  }

  const cache = loadCache(cachePath);
  const intervalMs = minIntervalMs ?? (cfg.updateIntervalHours ?? DEFAULT_INTERVAL_HOURS) * 3600 * 1000;
  if (now - (cache.lastCheck || 0) < intervalMs) {
    // 未到期：限频跳过（不访问网络）
    return { checked: false, hasUpdate: false, local: localVersion, latest: cache.knownLatest || null, notified: false };
  }

  const latest = latestVersion !== undefined ? latestVersion : await fetchLatestVersion();
  if (!latest) {
    // 查询失败：静默跳过（不记录 lastCheck，下次再试）
    return { checked: true, hasUpdate: false, local: localVersion, latest: null, notified: false };
  }

  const hasUpdate = compareVersions(latest, localVersion) > 0;
  const isNewVersion = hasUpdate && cache.knownLatest !== latest;

  if (isNewVersion && notify) {
    try {
      await notify(latest);
    } catch (error) {
      onLog(`更新提醒发送失败（将在下次检查重试）: ${String(error?.message ?? error)}`);
      // 提醒失败：不更新 knownLatest，下次检查会重试；只记录检查时间
      saveCache({ lastCheck: now, knownLatest: cache.knownLatest }, cachePath);
      return { checked: true, hasUpdate, local: localVersion, latest, notified: false };
    }
  }

  saveCache({ lastCheck: now, knownLatest: hasUpdate ? latest : cache.knownLatest }, cachePath);
  return { checked: true, hasUpdate, local: localVersion, latest, notified: isNewVersion };
}

/** 守护进程专用：发现新版本 → 推送手机提醒 */
export function makePhoneNotifier(config, { localVersion = getLocalVersion(), onLog = () => {} } = {}) {
  return async (latest) => {
    onLog(`检测到新版本 ${latest}（当前 ${localVersion}），已推送手机提醒`);
    const ok = await sendNotification({
      ...config,
      title: 'a4phone',
      message: `检测到新版本 ${latest}（当前 ${localVersion}）\n\n请运行：npm install -g a4phone 升级`,
    });
    if (!ok) throw new Error('手机推送失败');
  };
}

/** 命令级专用：发现新版本 → 终端打印提示 */
export function makeConsoleNotifier({ localVersion = getLocalVersion() } = {}) {
  return async (latest) => {
    console.log(`\n[提醒] a4phone 有新版本 ${latest}（当前 ${localVersion}），可运行 npm install -g a4phone 升级。\n`);
  };
}
