import type { GenerationEvent } from "../shared/logs";

export async function readGenerationStream(response: Response, receive: (event: GenerationEvent) => void) {
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    if (error?.requestId && error?.stage && typeof error?.message === "string") {
      receive({ type: "failure", requestId: error.requestId, stage: error.stage, message: error.message });
      return;
    }
    throw new Error("سرور درخواست را نپذیرفت (HTTP " + response.status + ").");
  }
  if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw new Error("گزارش زنده در دسترس نیست؛ سرور را به‌روز و دوباره راه‌اندازی کنید.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line) as GenerationEvent;
    if (event.type === "result" || event.type === "failure") finished = true;
    receive(event);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!finished) throw new Error("ارتباط با سرور قبل از پایان قطع شد؛ شناسهٔ اجرا را در فایل‌های لاگ بررسی کنید.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
