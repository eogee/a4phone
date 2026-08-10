// 配置读写：~/.a4phone/config.json
import fs from 'fs';
import { CONFIG_PATH, LAST_PATH, ensureDir } from './paths.mjs';

export { CONFIG_PATH, LAST_PATH } from './paths.mjs'; // 兼容旧引用

export function loadConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥离 UTF-8 BOM（PowerShell 写入可能带）
    const cfg = JSON.parse(raw);
    return {
      topic: cfg.topic || '',
      server: (cfg.server || 'https://ntfy.sh').replace(/\/+$/, ''),
      timeout: cfg.timeout ?? 60,
      planTimeout: cfg.planTimeout ?? 300,
      resumeTimeout: cfg.resumeTimeout ?? 1800, // 续聊超时（秒），默认 30 分钟
    };
  } catch {
    return { topic: '', server: 'https://ntfy.sh', timeout: 60, planTimeout: 300, resumeTimeout: 1800 };
  }
}

export function saveConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// 最近会话记录：Stop 事件写入，供续聊（a4p resume / a4p listen）读取
export function loadLastSession() {
  try {
    let raw = fs.readFileSync(LAST_PATH, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥离 UTF-8 BOM
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLastSession(session) {
  ensureDir();
  fs.writeFileSync(LAST_PATH, JSON.stringify({ ...session, ts: Date.now() }, null, 2));
}
