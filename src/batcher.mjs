// batcher.mjs — 串行批处理器
//
// 解决续聊守护进程的积压问题：一轮续聊最长可达 resumeTimeout（默认 1800 秒），
// 期间手机发来的消息若逐条排队，每条都会触发一个独立的续聊轮次（N 条 = N 轮），
// 手机内容会被无限期延迟。本模块把忙时到达的消息**合并为一个批次**，
// 当前轮结束后一次处理整批——任意数量积压最多只产生一条额外续聊轮次，
// 保证手机内容一定能送达 AI（顺序保留、串行执行、有界延迟）。
//
// 用法：
//   const batcher = createBatcher({
//     run: async ({ text, count, msgTime }) => { ...; return true }, // false=丢弃该批
//     log: (msg) => ...,
//   });
//   batcher.submit(text, msgTime); // 立即返回 drain 的 promise（fire-and-forget 也行）
//   batcher.restore(texts, msgTime); // 启动时恢复上次未处理的批次
//   batcher.pendingCount / batcher.pendingSnapshot() // 持久化与检查用
export function createBatcher({ run, log = () => {}, onTake = null }) {
  let draining = null; // 正在执行的 drain 循环（防止并发）
  const pending = { texts: [], msgTime: null };

  function enqueue(text, msgTime) {
    pending.texts.push(text);
    pending.msgTime = pending.msgTime == null ? msgTime : Math.min(pending.msgTime, msgTime);
    if (pending.texts.length === 2) {
      log('当前续聊进行中，后续消息将合并为一条续聊请求');
    }
  }

  // 串行排空循环：一次处理一批，过时/被拒批次丢弃后继续下一批（不会停顿）
  function drain() {
    if (!draining) {
      draining = (async () => {
        try {
          while (pending.texts.length) {
            const texts = pending.texts;
            const msgTime = pending.msgTime;
            pending.texts = [];
            pending.msgTime = null;
            // 取批即通知（P4-1：调用方在此删除持久化文件——批次已交付给续聊管线，
            // 进程崩溃不再恢复它，a4p 侧实现 at-most-once，避免同一条消息重复注入）
            if (onTake) {
              try { onTake({ texts, msgTime }); } catch {}
            }
            try {
              await run({ text: texts.join('\n\n'), count: texts.length, msgTime });
            } catch (error) {
              log(`批次处理异常（已跳过该批）: ${String(error?.message ?? error)}`);
            }
          }
        } finally {
          draining = null;
        }
      })();
    }
    return draining;
  }

  return {
    /** 提交一条消息；忙时自动合并进当前批次 */
    submit(text, msgTime) {
      enqueue(text, msgTime);
      return drain();
    },
    /** 启动时恢复上次未处理完的批次（触发排空） */
    restore(texts, msgTime) {
      if (!Array.isArray(texts) || !texts.length) return;
      for (const t of texts) pending.texts.push(String(t));
      pending.msgTime = msgTime ?? null;
      drain();
    },
    /** 当前积压条数（0 = 无积压） */
    get pendingCount() {
      return pending.texts.length;
    },
    /** 当前批次快照（供持久化） */
    pendingSnapshot() {
      return { texts: [...pending.texts], msgTime: pending.msgTime };
    },
  };
}
