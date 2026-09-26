import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { RunLogger, StageError, redact } from "../src/server/logger";
import { consumeCodexEvents } from "../src/server/codex-progress";
import { readGenerationStream } from "../src/web/generation-stream";
import type { GenerationEvent, LogEntry } from "../src/shared/logs";

async function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const directory = await mkdtemp(path.join(tmpdir(), "crawler-log-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const entries: LogEntry[] = [];
  return { directory, entries, logger: new RunLogger("test-run", directory, entry => entries.push(entry)) };
}

test("stage errors retain the failing stage and persist the same ordered events", async t => {
  const { logger, entries, directory } = await setup(t);
  await logger.stage("listing.fetch", "فهرست", async () => "html");
  await assert.rejects(logger.stage("article.fetch", "خبر", async () => {
    throw new Error("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
  }), error => error instanceof StageError && error.stage === "article.fetch");
  await logger.flush();
  const saved = (await readFile(path.join(directory, "test-run.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(saved, entries);
  assert.deepEqual(saved.map(entry => entry.status), ["started", "completed", "started", "failed"]);
  assert.equal(saved.at(-1).details.code, "ECONNREFUSED");
});

test("redacts known secrets, bearer tokens and URL credentials/query strings", () => {
  process.env.TEST_LOG_SECRET = "fake-secret-for-test";
  try {
    const cleaned = redact("fake-secret-for-test Bearer abc123 https://user:pass@example.com/news?token=private");
    assert.equal(cleaned, "[REDACTED] Bearer [REDACTED] https://example.com/news");
  } finally { delete process.env.TEST_LOG_SECRET; }
});

test("Codex stream returns the last response without logging raw model/tool content", async t => {
  const { logger, entries } = await setup(t);
  async function* events(): AsyncGenerator<ThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-test" };
    yield { type: "item.started", item: { id: "r", type: "reasoning", text: "private-reasoning" } };
    yield { type: "item.completed", item: { id: "tool", type: "command_execution", command: "private-command", aggregated_output: "private-output", status: "failed", exit_code: 1 } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "generated-source" } };
    yield { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
  }
  assert.equal(await consumeCodexEvents(events(), logger), "generated-source");
  const serialized = JSON.stringify(entries);
  for (const secret of ["private-reasoning", "private-command", "private-output", "generated-source"]) assert.equal(serialized.includes(secret), false);
  assert.ok(entries.some(entry => entry.level === "warn" && entry.details?.exitCode === 1));
  await logger.flush();
});

test("Codex fatal errors and premature stream close cannot appear as success", async t => {
  const { logger } = await setup(t);
  async function* failed(): AsyncGenerator<ThreadEvent> { yield { type: "turn.failed", error: { message: "model unavailable" } }; }
  async function* incomplete(): AsyncGenerator<ThreadEvent> { yield { type: "turn.started" }; }
  await assert.rejects(consumeCodexEvents(failed(), logger), /model unavailable/);
  await assert.rejects(consumeCodexEvents(incomplete(), logger), /بدون اعلام پایان/);
  await logger.flush();
});

test("Codex accepts a completed agent response when the SDK event stream never closes", async t => {
  const { logger, entries } = await setup(t);
  let returned = false;
  const events: AsyncIterable<ThreadEvent> = {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async () => {
          if (!sent) {
            sent = true;
            return { done: false as const, value: { type: "item.completed", item: { id: "answer", type: "agent_message", text: "usable-json" } } as ThreadEvent };
          }
          return await new Promise<IteratorResult<ThreadEvent>>(() => {});
        },
        return: async () => { returned = true; return { done: true as const, value: undefined }; },
      };
    },
  };
  assert.equal(await consumeCodexEvents(events, logger, 5), "usable-json");
  assert.equal(returned, true);
  assert.ok(entries.some(entry => entry.level === "warn" && entry.message.includes("بدون پیام پایان")));
  await logger.flush();
});

function responseFor(content: string) {
  const bytes = new TextEncoder().encode(content);
  // Split every byte, including Persian multi-byte characters and JSON boundaries.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

test("browser stream parser handles split UTF-8 and a terminal failure without newline", async () => {
  const result: GenerationEvent[] = [];
  const event: GenerationEvent = { type: "failure", requestId: "run", stage: "codex", message: "خطای آزمایشی" };
  await readGenerationStream(responseFor(JSON.stringify(event)), value => result.push(value));
  assert.deepEqual(result, [event]);
});

test("browser parser detects a disconnected stream with no terminal event", async () => {
  await assert.rejects(readGenerationStream(responseFor(""), () => {}), /قبل از پایان/);
});
