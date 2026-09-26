import type { Thread, ThreadEvent } from "@openai/codex-sdk";
import type { RunLogger } from "./logger";

const labels: Record<string, string> = {
  reasoning: "تحلیل ساختار صفحه",
  agent_message: "آماده‌سازی پاسخ",
  command_execution: "اجرای ابزار",
  mcp_tool_call: "فراخوانی ابزار متصل",
  file_change: "تغییر فایل",
  web_search: "جست‌وجو",
  todo_list: "به‌روزرسانی مراحل کار",
};

export async function consumeCodexEvents(events: AsyncIterable<ThreadEvent>, log: RunLogger, completedMessageGraceMs = 5_000): Promise<string> {
  let response = "";
  let completed = false;
  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    const next = response
      ? await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined; inferred: true }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined, inferred: true }), completedMessageGraceMs),
        ),
      ])
      : await iterator.next();
    if ("inferred" in next) {
      completed = true;
      log.log("codex", "progress", "پاسخ کامل Codex دریافت شد؛ جریان رویداد بدون پیام پایان بسته نشد.", undefined, "warn");
      void iterator.return?.();
      break;
    }
    if (next.done) break;
    const event = next.value;
    if (event.type === "thread.started") {
      log.log("codex", "progress", "نشست Codex آغاز شد.", { threadId: event.thread_id });
    } else if (event.type === "turn.started") {
      log.log("codex", "progress", "Codex درخواست را دریافت کرد.");
    } else if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    } else if (event.type === "error") {
      throw new Error(event.message);
    } else if (event.type === "turn.completed") {
      completed = true;
      log.log("codex", "progress", "تولید پاسخ پایان یافت.", { usage: event.usage });
    } else if (event.type === "item.started" || event.type === "item.completed") {
      const item = event.item;
      if (item.type === "agent_message" && event.type === "item.completed") response = item.text;
      // Never log commands, arguments, code, raw messages, or reasoning text.
      const failed = "status" in item && item.status === "failed";
      const details = { itemId: item.id, itemType: item.type, event: event.type,
        ...(item.type === "command_execution" ? { exitCode: item.exit_code } : {}) };
      log.log("codex", "progress",
        item.type === "error" ? "Codex یک خطای قابل بازیابی گزارش کرد." :
        (labels[item.type] ?? item.type) + (event.type === "item.started" ? " — آغاز" : failed ? " — ناموفق" : " — پایان"),
        details, failed || item.type === "error" ? "warn" : "info");
    }
  }
  if (!completed) throw new Error("ارتباط Codex بدون اعلام پایان قطع شد.");
  return response;
}

export async function runCodexWithProgress(thread: Pick<Thread, "runStreamed">, input: string, log: RunLogger, signal: AbortSignal, outputSchema?: unknown) {
  const started = Date.now();
  const heartbeat = setInterval(() => {
    log.log("codex", "progress", "هنوز منتظر پایان Codex هستیم.", { waitingMs: Date.now() - started });
  }, 10_000);
  try {
    const { events } = await thread.runStreamed(input, { signal, ...(outputSchema ? { outputSchema } : {}) });
    return await consumeCodexEvents(events, log);
  } finally {
    clearInterval(heartbeat);
  }
}
