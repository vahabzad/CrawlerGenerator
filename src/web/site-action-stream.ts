import type { SiteActionEvent } from "../shared/logs";

export async function readSiteActionStream(response: Response, receive: (event: SiteActionEvent) => void) {
  if (!response.ok || !response.body) throw new Error("سرور درخواست را نپذیرفت (HTTP " + response.status + ").");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", finished = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as SiteActionEvent;
    if (["test_result", "run_result", "chat_result", "failure"].includes(event.type)) finished = true;
    receive(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
    }
    consume(buffer + decoder.decode());
    if (!finished) throw new Error("ارتباط با سرور پیش از پایان عملیات قطع شد.");
  } finally { reader.releaseLock(); }
}
