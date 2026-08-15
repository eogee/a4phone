// autostart.mjs — 开机自启管理（Windows）
//
// 原理：在 Windows 启动文件夹（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）
// 写入一个隐藏启动的 VBS 脚本，登录时自动运行 `a4p listen`（守护进程本身无窗口、
// 后台运行）。不依赖注册表，无管理员权限要求，删除文件即关闭。
//
// 非 Windows 平台（WSL/Linux）暂不支持自动注册，返回明确提示（可手动用 tmux/systemd）。

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { A4P_DIR, ensureDir } from './paths.mjs';

/** 本包 bin 目录下 a4p 入口的绝对路径 */
function binEntryPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'a4p.mjs');
}

/** Windows 启动文件夹路径（当前用户） */
export function startupDir(platform = process.platform) {
  if (platform !== 'win32') return null;
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function startupVbsPath(platform = process.platform) {
  const dir = startupDir(platform);
  return dir ? path.join(dir, 'a4phone.vbs') : null;
}

/**
 * 生成 VBS 内容：隐藏窗口运行 `node <a4p 入口> listen`（绝对路径，不依赖 PATH）。
 * 纯函数便于测试。
 * 注意：shell.Run 的完整命令行必须是一个整体字符串，内嵌双引号需成对转义（""）。
 * @param {string} nodePath Node 可执行文件绝对路径
 * @param {string} binPath a4p.mjs 绝对路径
 */
export function buildVbsContent(nodePath, binPath) {
  const command = `"${nodePath}" "${binPath}" listen`;
  const escaped = command.replace(/"/g, '""');
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${escaped}", 0, False`,
    '',
  ].join('\r\n');
}

/** 开机自启是否已注册（启动文件夹 VBS 存在） */
export function isAutostartEnabled(platform = process.platform, vbsPath = startupVbsPath(platform)) {
  if (platform !== 'win32' || !vbsPath) return false;
  try {
    return fs.existsSync(vbsPath);
  } catch {
    return false;
  }
}

/** 开启开机自启：写入启动文件夹 VBS。返回 { ok, reason? } */
export function enableAutostart({ platform = process.platform, nodePath = process.execPath, binPath = binEntryPath(), vbsPath = startupVbsPath(platform) } = {}) {
  if (platform !== 'win32') {
    return { ok: false, reason: '非 Windows 平台暂不支持自动注册，可用 tmux / systemd 手动常驻。' };
  }
  if (!vbsPath) return { ok: false, reason: '无法确定启动文件夹位置。' };
  try {
    ensureDir(); // 确保 ~/.a4phone 存在（VBS 里用不到，但保持目录一致）
    fs.writeFileSync(vbsPath, buildVbsContent(nodePath, binPath));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `写入启动项失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 关闭开机自启：删除启动文件夹 VBS。返回 { ok, reason? } */
export function disableAutostart({ platform = process.platform, vbsPath = startupVbsPath(platform) } = {}) {
  if (platform !== 'win32') return { ok: false, reason: '非 Windows 平台。' };
  if (!vbsPath) return { ok: false };
  try {
    if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `移除启动项失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
