// 交互模式读写：~/.a4phone/mode.json（out=外出/手机优先，home=终端优先）
import fs from 'fs';
import { MODE_PATH, ensureDir } from './paths.mjs';

export { MODE_PATH } from './paths.mjs'; // 兼容旧引用

export function readMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_PATH, 'utf-8')).mode === 'out' ? 'out' : 'home';
  } catch {
    return 'home';
  }
}

export function setMode(mode) {
  ensureDir();
  fs.writeFileSync(MODE_PATH, JSON.stringify({ mode: mode === 'out' ? 'out' : 'home' }));
}
