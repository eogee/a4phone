// 后台守护进程管理：启动、停止、状态查询
//   启动：spawn 一个隐藏的 Node 子进程运行 a4p listen --daemon-child
//   停止：读取 PID 文件，taskkill 进程树
//   状态：检查 PID 是否存活
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DAEMON_JSON, LOG_PATH, ensureDir } from './paths.mjs';

function getScriptPath() {
  // 优先用 process.argv[1]（调用入口），兜底用模块路径
  return process.argv[1] || path.join(os.homedir(), 'bin', 'a4p.mjs');
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon() {
  // 检查是否已在运行
  try {
    const existing = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf-8'));
    if (existing.pid && isProcessAlive(existing.pid)) {
      console.log(`守护进程已在运行中（PID: ${existing.pid}）。`);
      console.log(`日志: ${existing.logPath}`);
      return;
    }
  } catch {}

  const scriptPath = getScriptPath();
  ensureDir();
  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [scriptPath, 'listen', '--daemon-child'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const pid = child.pid;
  const daemonInfo = { pid, logPath: LOG_PATH, startedAt: new Date().toISOString() };
  fs.writeFileSync(DAEMON_JSON, JSON.stringify(daemonInfo, null, 2));

  console.log(`续聊守护进程已后台启动（PID: ${pid}）。`);
  console.log(`日志: ${LOG_PATH}`);
}

export async function stopDaemon() {
  let daemonInfo;
  try {
    daemonInfo = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf-8'));
  } catch {
    console.log('未找到运行中的守护进程记录。');
    return;
  }

  const pid = daemonInfo.pid;
  if (!isProcessAlive(pid)) {
    console.log(`守护进程（PID: ${pid}）已不在运行。`);
    fs.unlinkSync(DAEMON_JSON);
    return;
  }

  // 结束进程：Windows 用 taskkill 杀进程树，其他平台用 kill
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' }).on('error', () => {});
    } else {
      process.kill(pid, 'SIGTERM');
    }
    // 给进程一点时间退出
    await new Promise((r) => setTimeout(r, 1000));
  } catch {}

  if (isProcessAlive(pid)) {
    console.log(`无法停止守护进程（PID: ${pid}），请手动终止。`);
    return;
  }

  fs.unlinkSync(DAEMON_JSON);
  console.log(`守护进程（PID: ${pid}）已停止。`);
}

export async function daemonStatus() {
  try {
    const daemonInfo = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf-8'));
    const pid = daemonInfo.pid;
    if (isProcessAlive(pid)) {
      console.log(`续聊守护进程运行中`);
      console.log(`  PID:    ${pid}`);
      console.log(`  启动:   ${daemonInfo.startedAt}`);
      console.log(`  日志:   ${daemonInfo.logPath}`);
    } else {
      console.log('守护进程记录存在但进程已不运行（可能异常退出）。');
      console.log(`  上次 PID: ${pid}`);
      console.log(`  日志:     ${daemonInfo.logPath}`);
      fs.unlinkSync(DAEMON_JSON);
    }
  } catch {
    console.log('续聊守护进程未运行。');
  }
}
