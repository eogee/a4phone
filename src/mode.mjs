// 交互模式读写：~/.a4phone-mode.json（out=外出/手机优先，home=终端优先）
import fs from 'fs';
import os from 'os';
import path from 'path';

export const MODE_PATH = path.join(os.homedir(), '.a4phone-mode.json');

export function readMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_PATH, 'utf-8')).mode === 'out' ? 'out' : 'home';
  } catch {
    return 'home';
  }
}

export function setMode(mode) {
  fs.writeFileSync(MODE_PATH, JSON.stringify({ mode: mode === 'out' ? 'out' : 'home' }));
}
