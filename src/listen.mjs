// 续聊守护进程：订阅主话题，手机向主话题发送文字即触发一次续聊。
//   断线自动重连（since 从上次消息之后继续），续聊请求串行处理（避免并发会话冲突）。
//   按消息时间戳过滤：如果新会话开启时间晚于用户的消息时间，则跳过该消息，
//   避免旧消息被注入到新会话中。
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, loadLastSession } from './config.mjs';
import { runResume } from './resume.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAY = 5000;

export function createLogWriter(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    stream.write(line);
  };
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
  let busy = false;
  const queue = [];
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

  const processMessage = async (text, msgTime) => {
    if (busy) {
      queue.push({ text, msgTime });
      return;
    }
    if (msgTime != null && isMessageStale(msgTime)) return; // 旧消息，丢弃
    busy = true;
    onLog(`收到续聊请求：${text.slice(0, 60)}`);
    const result = await runResume(text, { config, onLog });
    onLog(result.ok
      ? `消息已处理（resume 续聊${result.code != null ? `，退出码 ${result.code}` : ''}），结果已推送手机。`
      : `续聊失败：${result.reason}`);
    busy = false;
    if (queue.length) {
      const next = queue.shift();
      processMessage(next.text, next.msgTime);
    }
  };

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
          let msg;
          try {
            msg = JSON.parse(event.message); // 系统推送为 JSON，忽略
          } catch {
            msg = event.message; // 纯文本：手机发来的续聊内容
          }
          if (typeof msg === 'string' && msg.trim()) {
            processMessage(msg.trim(), event.time ? Number(event.time) : null);
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
