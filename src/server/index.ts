import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RunLogger, StageError, errorDetails } from "./logger";
import { generateRecipe } from "./generator";
import { publishBundle } from "./publisher";
import { assertPublicUrl } from "../crawler/runtime";
import type { GenerationEvent } from "../shared/logs";
import type { SiteActionEvent } from "../shared/logs";
import { chatAboutSite, getSite, getSiteArticle, listSiteArticles, listSites, readSiteOutput, runSiteFull, runSiteTest } from "./site-manager";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const requestSchema = z.object({ listingUrl: z.string().url(), articleUrl: z.union([z.string().url(), z.literal("")]).optional() });
const testSchema = z.object({ count: z.number().int().min(1).max(10).default(5) });
const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000), applyFix: z.boolean().default(false),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(20).default([]),
});
const reasoningEfforts = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);

function configuredReasoningEffort(): ModelReasoningEffort | undefined {
  const value = process.env.CODEX_REASONING_EFFORT as ModelReasoningEffort | undefined;
  if (!value) return undefined;
  if (!reasoningEfforts.has(value)) throw new Error("CODEX_REASONING_EFFORT نامعتبر است؛ نمونه‌های معتبر: low یا medium.");
  return value;
}

app.post("/api/generate", async (req, res) => {
  const requestId = randomUUID();
  const streaming = req.get("accept")?.includes("application/x-ndjson") ?? false;
  res.setHeader("X-Request-ID", requestId);
  const send = (event: GenerationEvent) => {
    if (streaming && !res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n");
  };
  if (streaming) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }
  const log = new RunLogger(requestId, path.resolve(root, process.env.LOG_DIR || "logs"), entry => send({ type: "log", entry }));
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error("ارتباط مرورگر قطع شد؛ عملیات لغو شد."));
  };
  res.on("close", onClose);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    log.log("request", "started", "درخواست ساخت کرالر دریافت شد.");
    const { listingUrl, articleUrl, model, effort, timeoutMs, browserWaitMs } = await log.stage("validation", "بررسی آدرس‌ها و تنظیمات", async () => {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) throw new Error("URL فهرست خبر را به‌درستی وارد کنید؛ خبر نمونه اختیاری است.");
      await assertPublicUrl(parsed.data.listingUrl);
      if (parsed.data.articleUrl) await assertPublicUrl(parsed.data.articleUrl);
      const timeoutMs = Number(process.env.GENERATION_TIMEOUT_MS || 600_000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
        throw new Error("GENERATION_TIMEOUT_MS باید عددی بین ۱۰۰۰ و ۳۶۰۰۰۰۰ باشد.");
      }
      const browserWaitMs = Number(process.env.BROWSER_WAIT_MS || 15000);
      if (!Number.isInteger(browserWaitMs) || browserWaitMs < 1000 || browserWaitMs > 60000) throw new Error("BROWSER_WAIT_MS باید بین ۱۰۰۰ و ۶۰۰۰۰ باشد.");
      return { ...parsed.data, browserWaitMs, model: process.env.CODEX_MODEL?.trim() || undefined, effort: configuredReasoningEffort(), timeoutMs };
    });
    timeout = setTimeout(() => controller.abort(new Error("مهلت اجرای ساخت کرالر تمام شد.")), timeoutMs);
    log.log("configuration", "progress", "تنظیمات این اجرا", { model: model ?? "local-default", reasoningEffort: effort ?? "local-default", timeoutMs });
    const recipe = await generateRecipe({ listingUrl, articleUrl: articleUrl || undefined, model, effort, browserWaitMs, workingDirectory: root }, log, controller.signal);
    const output = await publishBundle(root, recipe, log, controller.signal);
    log.log("request", "completed", "کرالر آزمایش شد و آمادهٔ اجرای مستقل است.", { file: output.file, ...output.strategies });
    await log.flush();
    if (!res.destroyed) {
      if (streaming) { send({ type: "result", requestId, ...output }); res.end(); }
      else res.json({ ok: true, requestId, ...output });
    }
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "request";
    const entry = log.log(stage, "failed", controller.signal.aborted
      ? String(controller.signal.reason?.message ?? "عملیات لغو شد.")
      : error instanceof StageError ? error.message : "خطای داخلی در ساخت کرالر؛ لاگ سرور را بررسی کنید.", errorDetails(error), "error");
    log.log("request", "failed", "ساخت کرالر متوقف شد.", { failedStage: stage }, "error");
    await log.flush();
    if (!res.destroyed) {
      if (streaming) { send({ type: "failure", requestId, stage, message: entry.message }); res.end(); }
      else res.status(stage === "validation" ? 400 : 500).json({ ok: false, requestId, stage, message: entry.message });
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", onClose);
  }
});
app.get("/api/sites", async (_req, res, next) => {
  try { res.json({ sites: await listSites(root) }); } catch (error) { next(error); }
});
app.get("/api/sites/:siteId", async (req, res, next) => {
  try { res.json(await getSite(root, req.params.siteId)); }
  catch (error) { next(error); }
});
app.get("/api/sites/:siteId/outputs/:file", async (req, res, next) => {
  try { res.json(await readSiteOutput(root, req.params.siteId, req.params.file)); }
  catch (error) { next(error); }
});
app.get("/api/sites/:siteId/articles", async (req, res, next) => {
  try { res.json(await listSiteArticles(root, req.params.siteId)); } catch (error) { next(error); }
});
app.get("/api/sites/:siteId/articles/:file/:index", async (req, res, next) => {
  try { res.json(await getSiteArticle(root, req.params.siteId, req.params.file, Number(req.params.index))); } catch (error) { next(error); }
});
app.post("/api/sites/:siteId/test", async (req, res) => {
  const requestId = randomUUID();
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Request-ID": requestId });
  res.flushHeaders();
  const send = (event: SiteActionEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n"); };
  const log = new RunLogger(requestId, path.resolve(root, process.env.LOG_DIR || "logs"), entry => send({ type: "log", entry }));
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(new Error("ارتباط مرورگر قطع شد؛ تست لغو شد.")); };
  res.on("close", onClose);
  try {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) throw new StageError("validation", "تعداد خبرهای تست باید بین ۱ تا ۱۰ باشد.");
    log.log("site.test", "started", "درخواست آزمایش کرالر دریافت شد.", { siteId: req.params.siteId, count: parsed.data.count });
    const result = await runSiteTest(root, req.params.siteId, parsed.data.count, log, controller.signal);
    log.log("site.test", "completed", "کرالر با موفقیت آزمایش شد.", result);
    await log.flush(); send({ type: "test_result", requestId, ...result }); res.end();
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "site.test";
    const entry = log.log(stage, "failed", error instanceof Error ? error.message : "آزمایش ناموفق بود.", errorDetails(error), "error");
    await log.flush(); send({ type: "failure", requestId, stage, message: entry.message }); res.end();
  } finally { res.off("close", onClose); }
});
app.post("/api/sites/:siteId/run", async (req, res) => {
  const requestId = randomUUID();
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Request-ID": requestId });
  res.flushHeaders();
  const send = (event: SiteActionEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n"); };
  const log = new RunLogger(requestId, path.resolve(root, process.env.LOG_DIR || "logs"), entry => send({ type: "log", entry }));
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(new Error("ارتباط مرورگر قطع شد؛ اجرا لغو شد.")); };
  res.on("close", onClose);
  try {
    log.log("site.run", "started", "درخواست اجرای کامل کرالر دریافت شد.", { siteId: req.params.siteId });
    const result = await runSiteFull(root, req.params.siteId, log, controller.signal);
    log.log("site.run", "completed", "اجرای کامل کرالر پایان یافت.", result);
    await log.flush(); send({ type: "run_result", requestId, ...result }); res.end();
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "site.run";
    const entry = log.log(stage, "failed", error instanceof Error ? error.message : "اجرای کرالر ناموفق بود.", errorDetails(error), "error");
    await log.flush(); send({ type: "failure", requestId, stage, message: entry.message }); res.end();
  } finally { res.off("close", onClose); }
});
app.post("/api/sites/:siteId/chat", async (req, res) => {
  const requestId = randomUUID();
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Request-ID": requestId });
  res.flushHeaders();
  const send = (event: SiteActionEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n"); };
  const log = new RunLogger(requestId, path.resolve(root, process.env.LOG_DIR || "logs"), entry => send({ type: "log", entry }));
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(new Error("ارتباط مرورگر قطع شد؛ عملیات لغو شد.")); };
  res.on("close", onClose);
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw new StageError("validation", "پیام گفتگو معتبر نیست.");
    const { message, history, applyFix } = parsed.data;
    if (applyFix) {
      const site = await getSite(root, req.params.siteId);
      log.log("site.repair", "started", "اصلاح قواعد این سایت با Codex آغاز شد.", { siteId: site.id });
      const browserWaitMs = Number(process.env.BROWSER_WAIT_MS || 15000);
      const recipe = await generateRecipe({ listingUrl: site.listingUrl, articleUrl: site.sampleArticleUrl || undefined, model: process.env.CODEX_MODEL?.trim() || undefined, effort: configuredReasoningEffort(), browserWaitMs, workingDirectory: root, feedback: message }, log, controller.signal);
      await publishBundle(root, recipe, log, controller.signal);
      const updated = await getSite(root, req.params.siteId);
      const reply = `اصلاح انجام شد و نسخهٔ جدید پس از آزمایش چندخبره فعال شد. فهرست ${updated.listingCount} خبر دارد و ${updated.verifiedArticles} خبر در آزمون انتشار بررسی شد.`;
      log.log("site.repair", "completed", "نسخهٔ اصلاح‌شده با موفقیت فعال شد.", { version: updated.version });
      await log.flush(); send({ type: "chat_result", requestId, message: reply, site: updated }); res.end();
    } else {
      log.log("site.chat", "started", "پیام برای بررسی کرالر به Codex ارسال شد.", { siteId: req.params.siteId });
      const reply = await chatAboutSite(root, req.params.siteId, message, history, process.env.CODEX_MODEL?.trim() || undefined, configuredReasoningEffort(), log, controller.signal);
      log.log("site.chat", "completed", "پاسخ Codex آماده شد.");
      await log.flush(); send({ type: "chat_result", requestId, message: reply }); res.end();
    }
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "site.chat";
    const entry = log.log(stage, "failed", controller.signal.aborted ? "عملیات لغو شد." : error instanceof Error ? error.message : "گفتگو ناموفق بود.", errorDetails(error), "error");
    await log.flush(); send({ type: "failure", requestId, stage, message: entry.message }); res.end();
  } finally { res.off("close", onClose); }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, services: { postgres: Boolean(process.env.DATABASE_URL), redis: Boolean(process.env.REDIS_URL) } }));
const handleHttpError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const requestId = randomUUID();
  const log = new RunLogger(requestId, path.resolve(root, process.env.LOG_DIR || "logs"), () => {});
  const status = error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : 500;
  const message = status === 413 ? "حجم درخواست بیش از حد مجاز است." : status === 400 ? "بدنهٔ درخواست JSON معتبر نیست." : "خطای داخلی سرور.";
  log.log("request.parse", "failed", message, { httpStatus: status }, "error");
  void log.flush().finally(() => {
    if (!res.destroyed) res.status(status).set("X-Request-ID", requestId).json({ ok: false, requestId, stage: "request.parse", message });
  });
};
app.use(handleHttpError);
app.listen(port, () => console.log(`Crawler Generator API: http://localhost:${port}`));
