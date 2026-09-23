import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("API streams validation errors, persists them, and preserves JSON clients", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "crawler-api-log-test-"));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: String(port), LOG_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API startup timed out")), 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("API exited before startup")); });
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("Crawler Generator API:")) { clearTimeout(timer); resolve(); }
    });
  });
  const url = "http://127.0.0.1:" + port + "/api/generate";
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({ listingUrl: "http://127.0.0.1/news", articleUrl: "http://127.0.0.1/story" }),
  });
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  const requestId = response.headers.get("x-request-id");
  assert.ok(requestId);
  assert.equal(response.status, 200);
  assert.equal(events.at(-1).type, "failure");
  assert.equal(events.at(-1).stage, "validation");
  assert.ok(events.some(event => event.type === "log" && event.entry.status === "started"));
  const saved = (await readFile(path.join(directory, requestId + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(saved, events.filter(event => event.type === "log").map(event => event.entry));

  const json = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const payload = await json.json();
  assert.equal(json.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.stage, "validation");
  assert.notEqual(payload.requestId, requestId);

  const malformed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).stage, "request.parse");
});
