// ntfy.sh 推送与响应订阅

/**
 * 解析 ntfy 消息体：
 *   - JSON 对象（如按钮回执 { requestId, answer }）→ 原样返回对象
 *   - JSON 原始值（"4" / "true" / "null" 等合法 JSON 字面量）→ 按文本返回
 *     （修复：JSON.parse('4') 会返回数字 4，导致纯数字自由文本被误判为 JSON 对象而丢失）
 *   - 非 JSON 文本 → 原样返回
 * @param {string} raw ntfy 事件的 message 字段
 * @returns {object|string}
 */
export function parseNtfyMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : raw;
  } catch {
    return raw;
  }
}

export const MAX_MESSAGE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 8000;

export function ntfyAuthHeaders(token) {
  const value = String(token || '').trim();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

export function ntfyFailureReason(status) {
  if (status === 403) return 'HTTP 403（令牌无效或话题无访问权限）';
  if (status === 429) return 'HTTP 429（触发服务限速，请降低推送频率）';
  return `HTTP ${status}`;
}

export function truncateUtf8(text, maxBytes = MAX_MESSAGE_BYTES) {
  if (maxBytes <= 0) return '';
  const value = String(text ?? '');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  const suffix = '...';
  if (maxBytes <= suffix.length) return suffix.slice(0, maxBytes);
  let end = maxBytes - suffix.length;
  // Back up to a UTF-8 character boundary so the suffix never follows a broken character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8') + suffix;
}

export async function sendNotification({ server, topic, title, message, actions, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!topic) return { ok: false, reason: '话题未配置' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ntfyAuthHeaders(token) },
      body: JSON.stringify({ topic, title, message: truncateUtf8(message), actions }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true, reason: '' } : { ok: false, reason: ntfyFailureReason(res.status) };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { ok: false, reason: timedOut ? '请求超时' : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

// 订阅响应话题（NDJSON 流），等待决策
//   HTTP action 回传：正文为 JSON { requestId, answer }，仅匹配相同 requestId
//   手机自由文本：正文为纯文本，无 requestId，直接作为答案接受
export async function waitForResponse({ server, topic, requestId, timeout, token }) {
  const url = `${server}/${topic}-response/json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: ntfyAuthHeaders(token) });
    if (!res.ok) return null;
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
        try {
          const event = JSON.parse(line);
          // ntfy /json 连接建立后会先发 open 事件、之后周期发 keepalive，
          // 这些事件没有 message 字段，跳过以免被误判为“手机自由文本”立即返回。
          if (event.event !== 'message' || event.message == null) continue;
          const parsed = parseNtfyMessage(event.message);
          const msg = typeof parsed === 'object' ? parsed : { answer: parsed };
          // action 回执：requestId 必须匹配；自由文本：无 requestId 且有 answer 才接受
          if (msg.requestId === requestId || (msg.requestId === undefined && msg.answer)) {
            controller.abort();
            return msg;
          }
        } catch {}
      }
    }
  } catch {} finally {
    clearTimeout(timer);
  }
  return null;
}
