// 配置读写：~/.a4phone.json
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CONFIG_PATH = path.join(os.homedir(), '.a4phone.json');

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      topic: cfg.topic || '',
      server: (cfg.server || 'https://ntfy.sh').replace(/\/+$/, ''),
      timeout: cfg.timeout ?? 30,
      planTimeout: cfg.planTimeout ?? 300,
    };
  } catch {
    return { topic: '', server: 'https://ntfy.sh', timeout: 30, planTimeout: 300 };
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
