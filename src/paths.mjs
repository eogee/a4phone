// a4phone 状态文件统一存放目录：~/.a4phone/（替代散落在家目录的单点文件）
//   config.json  ← ~/.a4phone.json
//   mode.json    ← ~/.a4phone-mode.json
//   last.json    ← ~/.a4phone-last.json
//   daemon.json  ← ~/.a4phone-daemon.json
//   daemon.log   ← ~/.a4phone-daemon.log
import fs from 'fs';
import os from 'os';
import path from 'path';

export const A4P_DIR = path.join(os.homedir(), '.a4phone');
export const CONFIG_PATH = path.join(A4P_DIR, 'config.json');
export const MODE_PATH = path.join(A4P_DIR, 'mode.json');
export const LAST_PATH = path.join(A4P_DIR, 'last.json');
export const DAEMON_JSON = path.join(A4P_DIR, 'daemon.json');
export const LOG_PATH = path.join(A4P_DIR, 'daemon.log');

// DSH 续聊文件队列：a4p（守护进程/manual resume）写 req-<id>.json，
// dsh web 进程内的插件处理后写 resp-<id>.json 并删除请求文件。
export const DSH_JOB_DIR = path.join(A4P_DIR, 'dsh-jobs');
// DSH 插件心跳：dsh web 每次轮询刷新，a4p 据此判断 dsh web 是否在运行
export const DSH_HEARTBEAT = path.join(A4P_DIR, 'dsh-heartbeat.json');
// 续聊积压批次持久化：长轮次期间到达的消息写入该文件，守护进程重启后恢复，
// 避免积压消息在重启时丢失
export const PENDING_PATH = path.join(A4P_DIR, 'pending-batch.json');
// 桌面通知请求队列：hook 进程写请求文件（ZCode 执行端口会在 hook 退出时杀进程树，
// fire-and-forget 的气泡来不及显示），常驻续聊守护进程读取并代发
export const NOTIFY_QUEUE_DIR = path.join(A4P_DIR, 'notify-queue');
// 版本更新检查缓存：{ lastCheck, knownLatest }，用于限频与"同一新版本只提醒一次"
export const UPDATE_CACHE_PATH = path.join(A4P_DIR, 'update-cache.json');

// 旧版散落在家目录的单文件 → 迁移到 ~/.a4phone/（新路径不存在时才移动）
const LEGACY_PATHS = {
  [CONFIG_PATH]: path.join(os.homedir(), '.a4phone.json'),
  [MODE_PATH]: path.join(os.homedir(), '.a4phone-mode.json'),
  [LAST_PATH]: path.join(os.homedir(), '.a4phone-last.json'),
  [DAEMON_JSON]: path.join(os.homedir(), '.a4phone-daemon.json'),
  [LOG_PATH]: path.join(os.homedir(), '.a4phone-daemon.log'),
};

function moveIfExists(oldPath, newPath) {
  try {
    fs.renameSync(oldPath, newPath);
    return true;
  } catch {
    // rename 失败（如日志被占用）则回退复制+删除
    try {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return true;
    } catch {
      return false; // 迁移失败则保留旧文件
    }
  }
}

// 确保目录存在，并把旧版散点文件迁移进来；返回是否发生过迁移
export function migrateLegacy() {
  fs.mkdirSync(A4P_DIR, { recursive: true });
  let migrated = false;
  for (const [newPath, oldPath] of Object.entries(LEGACY_PATHS)) {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      if (moveIfExists(oldPath, newPath)) migrated = true;
    }
  }
  return migrated;
}

// 确保目录存在（写入前调用）
export function ensureDir() {
  fs.mkdirSync(A4P_DIR, { recursive: true });
}
