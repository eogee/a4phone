// 续聊守护进程：订阅主话题，手机向主话题发送文字即触发一次续聊。
//   断线自动重连（since 从上次消息之后继续），续聊请求串行处理（避免并发会话冲突）。
//   积压合并：一轮续聊最长 resumeTimeout（默认 1800 秒），忙时到达的手机消息
//   合并为一个批次，当前轮结束后一次续聊处理整批（任意数量积压最多只多一轮），
//   保证手机内容一定能送达 AI；批次持久化到 ~/.a4phone/pending-batch.json，
//   守护进程重启后自动恢复，避免积压消息丢失。
//   按消息时间戳过滤：如果新会话开启时间晚于用户的消息时间，则跳过该消息，
//   避免旧消息被注入到新会话中。
import fs from 'fs';
import path from 'path';
import { loadConfig, loadLastSession } from './config.mjs';
import { runResume } from './resume.mjs';
import { createBatcher } from './batcher.mjs';
import { checkForUpdate, makePhoneNotifier } from './update-check.mjs';
import { parseNtfyMessage } from './ntfy.mjs';
import { PENDING_PATH, ensureDir } from './paths.mjs';
import { configureDsh } from './setup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAY = 5000;
// DSH profile 自动发现扫描间隔：新装 profile（如后续安装的 tui/dsh-tui 变体）
// 无需重跑 a4p setup，守护进程周期重扫自动补挂
const PROFILE_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 扫描 ~/.dsh/profiles 并为所有 profile 补挂 dsh-hook（幂等），
 * 有新挂载时写日志。导出便于测试与手动调用。
 * @param {(msg: string) => void} [onLog]
 * @param {object} [opts] 透传给 configureDsh（profilesDir/pluginEntry，测试用）
 * @returns {string[]} 本次新挂载的 profile 名列表
 */
export function ensureDshProfiles(onLog = () => {}, opts = {}) {
  try {
    const r = configureDsh(opts);
    if (r && Array.isArray(r.mounted) && r.mounted.length) {
      onLog(`发现 DSH profile，已自动挂载手机交互插件：${r.mounted.join('、')}`);
      return r.mounted;
    }
  } catch {}
  return [];
}

export function createLogWriter(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    stream.write(line);
  };
}

// 原子写 JSON（临时文件 + rename，避免读者读到半个文件）
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

export async function runListen({ onLog = (s) => console.log(s) } = {}) {
  const config = loadConfig();
  if (!config.topic) {
    onLog('未配置话题，请先运行 a4p setup。');
    return false;
  }
  const url = `${config.server}/${config.topic}/json`;
  onLog(`续聊守护进程已启动，监听: ${url}`);
  onLog(`提示：手机向话题 ${config.topic} 发送文字即可与当前会话交流；Ctrl+C 退出。`);

  // ntfy 的 since 参数只接受 Unix 秒时间戳/时长/all，不接受 "now" 或消息 ID
  let lastTime = Math.floor(Date.now() / 1000); // 首次只收连接之后的新消息
  let knownSessionId = null; // 记录已处理过的会话 ID，用于检测会话切换

  // 判断消息是否仍应被处理：如果新会话在消息发送之后才创建，则丢弃
  function isMessageStale(msgTime) {
    const last = loadLastSession();
    if (!last?.session_id) return false; // 无最近会话，不过滤
    // 首次处理或会话未变，不过滤
    if (knownSessionId === last.session_id) return false;
    // 会话变了：检查消息是否是在新会话创建之前发送的
    // last.ts 是 Stop 事件的保存时间（毫秒），msgTime 是 ntfy 的 Unix 秒
    if (msgTime * 1000 < last.ts) {
      onLog(`丢弃过时消息（消息时间 ${msgTime} 早于新会话创建时间 ${Math.floor(last.ts / 1000)}）`);
      return true;
    }
    // 会话变了但消息更新，更新 knownSessionId 并处理
    knownSessionId = last.session_id;
    return false;
  }

  // 批次持久化：积压非空写文件，排空后删除（守护进程重启后恢复）
  function persistSnapshot() {
    try {
      ensureDir();
      const snapshot = batcher.pendingSnapshot();
      if (snapshot.texts.length) {
        atomicWriteJson(PENDING_PATH, snapshot);
      } else {
        try { fs.unlinkSync(PENDING_PATH); } catch {}
      }
    } catch {}
  }

  const batcher = createBatcher({
    log: onLog,
    // 取批即删持久化文件（P4-1 a4p 侧 at-most-once）：批次一旦交给续聊管线，
    // 进程崩溃后不再恢复，避免同一条手机消息重复注入会话
    onTake: persistSnapshot,
    run: async ({ text, count, msgTime }) => {
      try {
        if (msgTime != null && isMessageStale(msgTime)) return false; // 旧消息，丢弃
        if (count > 1) onLog(`合并 ${count} 条积压消息为一条续聊请求`);
        onLog(`收到续聊请求：${text.slice(0, 60)}`);
        const result = await runResume(text, { config, onLog });
        onLog(result.ok
          ? `消息已处理（resume 续聊${result.code != null ? `，退出码 ${result.code}` : ''}），结果已推送手机。`
          : `续聊失败：${result.reason}`);
        return true;
      } finally {
        // 批次处理完成（或已丢弃）后刷新持久化：
        // 期间若有新积压则保留到文件，否则清空，避免重启后重复处理已完成批次
        persistSnapshot();
      }
    },
  });

  // 启动恢复：上次未处理完的积压批次（守护进程重启/崩溃不丢消息）
  try {
    const raw = fs.readFileSync(PENDING_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    if (Array.isArray(saved?.texts) && saved.texts.length) {
      onLog(`恢复 ${saved.texts.length} 条重启前未处理的续聊消息，继续处理...`);
      batcher.restore(saved.texts, saved.msgTime ?? null);
    }
  } catch {}

  // ── 版本更新检查：启动时 + 周期性（默认 6 小时），发现新版本推送手机提醒 ──
  // 限频与去重由 update-check 的缓存保证（同一新版本只提醒一次，未到期不访问网络）
  const checkUpdate = async () => {
    try {
      await checkForUpdate({
        config,
        notify: makePhoneNotifier(config, { onLog }),
        onLog,
      });
    } catch {}
  };
  await checkUpdate();
  const intervalMs = (config.updateIntervalHours ?? 6) * 3600 * 1000;
  setInterval(() => { checkUpdate().catch(() => {}); }, intervalMs).unref();

  // ── DSH profile 自动发现：启动时 + 周期扫描，新装 profile 自动补挂插件 ──
  ensureDshProfiles(onLog);
  setInterval(() => { ensureDshProfiles(onLog); }, PROFILE_SCAN_INTERVAL_MS).unref();

  while (true) {
    try {
      const since = `since=${lastTime + 1}`; // 从最后收到的消息之后继续
      const res = await fetch(`${url}?${since}`);
      if (!res.ok) {
        onLog(`连接失败（HTTP ${res.status}），${RETRY_DELAY / 1000} 秒后重连...`);
        await sleep(RETRY_DELAY);
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.time) lastTime = Math.max(lastTime, Number(event.time));
          // 有 title 的是系统推送通知（Claude Code 回复），不是手机用户消息，跳过
          if (event.title) continue;
          // 系统推送为 JSON 对象则忽略；纯文本/JSON 原始值（如手机发的单数字"3"）作为续聊内容
          const msg = parseNtfyMessage(event.message);
          if (typeof msg === 'string' && msg.trim()) {
            batcher.submit(msg.trim(), event.time ? Number(event.time) : null);
            persistSnapshot();
          }
        }
      }
      onLog(`连接断开，${RETRY_DELAY / 1000} 秒后重连...`);
      await sleep(RETRY_DELAY);
    } catch (err) {
      onLog(`连接异常（${err.message}），${RETRY_DELAY / 1000} 秒后重连...`);
      await sleep(RETRY_DELAY);
    }
  }
}
