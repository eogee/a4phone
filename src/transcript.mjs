// 从会话记录（transcript）抽取"AI 最后输出的一段话"
//   Claude Code：JSONL，type="assistant" 的 message.content[] 中 type="text" 的 text 块
//   Codex：JSONL，type="response_item" 且 payload.type="message" 的 assistant 消息——它随消息即时写入，
//          而 task_complete 事件比消息晚 ~1.4s 才落盘，Codex 触发 Stop 时读取往往还没写入，
//          所以必须先取 message 事件，task_complete 仅作文件稳定时的兜底。
//   ZCode：hook 触发时把合成 transcript 写入临时文件，Stop 时只有一行伪 assistant 消息
//          （结构与 Claude Code 相同但顶层无 type，role 在 message.role）；该临时文件在
//          hook 进程退出即被 ZCode 清理，且 Stop 载荷已直送 last_assistant_message，
//          因此优先走 resolveLastOutput，此解析仅作兜底。
import fs from 'fs';

const MAX_LENGTH = 1000; // 推送内容截断长度（中文约 3000 字节，留足 ntfy 4KB 上限余量）

// 截断/清洗：空文本返回 null（extractLastOutput 与直送字段共用同一上限）
export function clampOutput(text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_LENGTH ? cleaned.slice(0, MAX_LENGTH) + '...' : cleaned;
}

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
      // ZCode：合成的单行伪 transcript 结构相同，只是顶层没有 type，role 在 message.role
      if ((o?.type === 'assistant' || o?.message?.role === 'assistant') && Array.isArray(o.message?.content)) {
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
  return clampOutput(text);
}

// Stop 载荷 → AI 最后输出：ZCode 在 stdin 直送 last_assistant_message（首选——免文件
// 解析，且其临时 transcript 在 hook 退出即被清理）；其余 agent 无此字段，回退读 transcript 文件
export function resolveLastOutput({ last_assistant_message, transcript_path } = {}) {
  return clampOutput(last_assistant_message) ?? extractLastOutput(transcript_path);
}
