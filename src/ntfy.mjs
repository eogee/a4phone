// ntfy.sh 推送与响应订阅
export async function sendNotification({ server, topic, title, message, actions }) {
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, actions }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 订阅响应话题（NDJSON 流），等待决策
//   HTTP action 回传：正文为 JSON { requestId, answer }，仅匹配相同 requestId
//   手机自由文本：正文为纯文本，无 requestId，直接作为答案接受
export async function waitForResponse({ server, topic, requestId, timeout }) {
  const url = `${server}/${topic}-response/json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
          let msg;
          try {
            msg = JSON.parse(event.message);
          } catch {
            msg = { answer: event.message }; // 纯文本：手机自由作答
          }
          if (msg.requestId === requestId || msg.requestId === undefined) {
            clearTimeout(timer);
            controller.abort();
            return msg;
          }
        } catch {}
      }
    }
  } catch {}
  clearTimeout(timer);
  return null;
}
