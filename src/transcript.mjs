// 从会话记录（transcript）抽取"AI 最后输出的一段话"
//   Claude Code：JSONL，type="assistant" 的 message.content[] 中 type="text" 的 text 块
//   Codex：JSONL，type="response_item" 且 payload.type="message" 的 assistant 消息——它随消息即时写入，
//          而 task_complete 事件比消息晚 ~1.4s 才落盘，Codex 触发 Stop 时读取往往还没写入，
//          所以必须先取 message 事件，task_complete 仅作文件稳定时的兜底。
import fs from 'fs';

const MAX_LENGTH = 1000; // 推送内容截断长度（中文约 3000 字节，留足 ntfy 4KB 上限余量）

export function extractLastOutput(transcriptPath) {
  if (!transcriptPath) return null;
  let text = '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行（如 Codex 的纯文本记录）跳过
      }
      // Claude Code：assistant 消息的 text 块（多轮时取最后一条）
      if (o?.type === 'assistant' && Array.isArray(o.message?.content)) {
        const parts = o.message.content
          .filter((b) => b?.type === 'text' && b.text)
          .map((b) => b.text);
        if (parts.length) text = parts.join('\n');
      }
      // Codex：response_item 的 assistant 消息（随消息即时写入，Stop 时已可用）
      if (o?.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'assistant') {
        const parts = (o.payload.content || [])
          .filter((b) => b?.type === 'output_text' && b.text)
          .map((b) => b.text);
        if (parts.length) text = parts.join('\n');
      }
      // Codex：task_complete 兜底（自带最后一条 agent 消息；比 message 晚 ~1.4s 写入，仅文件稳定时可用）
      if (o?.type === 'event_msg' && o.payload?.type === 'task_complete' && o.payload?.last_agent_message) {
        text = o.payload.last_agent_message;
      }
    }
  } catch {
    return null;
  }
  const cleaned = (text || '').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_LENGTH ? cleaned.slice(0, MAX_LENGTH) + '...' : cleaned;
}
