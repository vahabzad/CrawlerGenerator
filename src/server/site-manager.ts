import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Article, Recipe } from "../crawler/recipe";
import type { SiteArticleCollection, SiteDetails, SiteOutputSummary, SiteSummary } from "../shared/logs";
import { runCodexWithProgress } from "./codex-progress";
import type { RunLogger } from "./logger";

const siteIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const outputPattern = /^[0-9TZ-]+-[0-9a-f-]+\.json$/i;

function sitesRoot(root: string) { return path.join(root, "generated", "sites"); }
function assertSiteId(id: string) {
  if (!siteIdPattern.test(id)) throw new Error("شناسهٔ سایت معتبر نیست.");
  return id;
}
async function directories(directory: string) {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function activeVersion(root: string, id: string) {
  const siteDirectory = path.join(sitesRoot(root), assertSiteId(id));
  const versionsRoot = path.join(siteDirectory, "versions");
  let published: string | null = null;
  try {
    const wrapper = await readFile(path.join(siteDirectory, "crawler.ts"), "utf8");
    published = wrapper.match(/\.\/versions\/([0-9TZ-]+)\/crawler/)?.[1] ?? null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const discovered = (await directories(versionsRoot)).sort().reverse();
  const versions = published ? [published, ...discovered.filter(version => version !== published)] : discovered;
  for (const version of versions) {
    const directory = path.join(versionsRoot, version);
    try {
      const [recipe, sample] = await Promise.all([
        readFile(path.join(directory, "recipe.json"), "utf8").then(value => JSON.parse(value) as Recipe),
        readFile(path.join(directory, "sample.json"), "utf8").then(value => JSON.parse(value) as { listingCount?: number; article?: Article; articles?: Article[] }),
      ]);
      return { version, directory, recipe, sample };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("نسخهٔ فعال و آزمایش‌شده‌ای برای این سایت پیدا نشد.");
}
async function outputSummaries(directory: string): Promise<SiteOutputSummary[]> {
  const outputDirectory = path.join(directory, "outputs");
  let names: string[];
  try { names = (await readdir(outputDirectory)).filter(name => outputPattern.test(name)).sort().reverse().slice(0, 30); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(names.map(async file => {
    try {
      const value = JSON.parse(await readFile(path.join(outputDirectory, file), "utf8")) as Record<string, unknown>;
      return { file, createdAt: String(value.crawledAt ?? ""), status: String(value.status ?? "unknown"), mode: String(value.mode ?? "unknown"), discovered: Number(value.discovered ?? 0), extracted: Array.isArray(value.items) ? value.items.length : 0, failed: Array.isArray(value.errors) ? value.errors.length : 0 };
    } catch { return { file, createdAt: "", status: "unreadable", mode: "unknown", discovered: 0, extracted: 0, failed: 0 }; }
  }));
}
function summarize(id: string, active: Awaited<ReturnType<typeof activeVersion>>, outputCount: number): SiteSummary {
  return {
    id, listingUrl: active.recipe.listingUrl, version: active.version,
    updatedAt: active.version.replace(/-(\d{3})Z$/, ".$1Z").replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"),
    listingMode: active.recipe.listing.mode, articleMode: active.recipe.article.mode,
    articlePattern: active.recipe.listing.urlPattern ?? null,
    verifiedArticles: active.sample.articles?.length ?? (active.sample.article ? 1 : 0),
    listingCount: active.sample.listingCount ?? 0, outputCount,
  };
}
export async function listSites(root: string): Promise<SiteSummary[]> {
  const ids = (await directories(sitesRoot(root))).filter(id => siteIdPattern.test(id));
  const sites = await Promise.all(ids.map(async id => {
    try { const active = await activeVersion(root, id); const outputs = await outputSummaries(active.directory); return summarize(id, active, outputs.length); }
    catch { return null; }
  }));
  return sites.filter((site): site is SiteSummary => Boolean(site)).sort((a, b) => b.version.localeCompare(a.version));
}
export async function getSite(root: string, id: string): Promise<SiteDetails> {
  const active = await activeVersion(root, id);
  const outputs = await outputSummaries(active.directory);
  return { ...summarize(id, active, outputs.length), sampleArticleUrl: active.sample.article?.url ?? active.sample.articles?.[0]?.url ?? null, outputs };
}
export async function readSiteOutput(root: string, id: string, file: string) {
  if (!outputPattern.test(file)) throw new Error("نام فایل خروجی معتبر نیست.");
  const active = await activeVersion(root, id);
  return JSON.parse(await readFile(path.join(active.directory, "outputs", file), "utf8"));
}
async function latestArticleOutput(root: string, id: string) {
  const active = await activeVersion(root, id);
  const outputDirectory = path.join(active.directory, "outputs");
  let names: string[] = [];
  try { names = (await readdir(outputDirectory)).filter(name => outputPattern.test(name)).sort().reverse(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let fallback: { file: string; value: Record<string, unknown> } | null = null;
  for (const file of names) {
    try {
      const value = JSON.parse(await readFile(path.join(outputDirectory, file), "utf8")) as Record<string, unknown>;
      if (!Array.isArray(value.items) || !value.items.length) continue;
      if (!fallback) fallback = { file, value };
      if (["all", "new"].includes(String(value.mode))) return { file, value };
    } catch { /* Ignore incomplete output while a run is still writing it. */ }
  }
  return fallback;
}
export async function listSiteArticles(root: string, id: string): Promise<SiteArticleCollection> {
  const output = await latestArticleOutput(root, id);
  if (!output) return { outputFile: null, status: "empty", discovered: 0, failed: 0, articles: [] };
  const items = output.value.items as Article[];
  return {
    outputFile: output.file, status: String(output.value.status ?? "unknown"),
    discovered: Number(output.value.discovered ?? items.length),
    failed: Array.isArray(output.value.errors) ? output.value.errors.length : 0,
    articles: items.map((article, index) => ({ index, url: article.url, title: article.title, imageUrl: article.imageUrl, publishedAt: article.publishedAt, author: article.author, summary: article.summary, categories: article.categories ?? [], tags: article.tags ?? [] })),
  };
}
export async function getSiteArticle(root: string, id: string, file: string, index: number): Promise<Article> {
  if (!outputPattern.test(file) || !Number.isInteger(index) || index < 0) throw new Error("شناسهٔ خبر معتبر نیست.");
  const active = await activeVersion(root, id);
  const value = JSON.parse(await readFile(path.join(active.directory, "outputs", file), "utf8")) as { items?: Article[] };
  const article = value.items?.[index];
  if (!article) throw new Error("خبر موردنظر در خروجی پیدا نشد.");
  return article;
}
export async function runSiteTest(root: string, id: string, count: number, log: RunLogger, signal: AbortSignal) {
  const active = await activeVersion(root, id);
  const entry = path.join(sitesRoot(root), id, "crawler.ts");
  return await log.stage("site.test", `آزمایش واقعی کرالر روی ${count} خبر`, () => new Promise<{listingCount:number;verifiedArticles:number;outputFile:string}>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "dotenv/config", "--import", "tsx", entry, "--verify", `--verify-count=${count}`], { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderrBuffer = "";
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 8_000_000) child.kill(); });
    child.stderr.on("data", chunk => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/); stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try { const event = JSON.parse(line) as Record<string, unknown>; log.log("site.runner", "progress", String(event.message ?? event.stage ?? "پیام کرالر"), Object.fromEntries(Object.entries(event).filter(([key]) => !["message", "timestamp"].includes(key)))); }
        catch { if (line.trim()) log.log("site.runner", "progress", line.trim().slice(0, 500)); }
      }
    });
    child.once("error", reject);
    child.once("close", code => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) { reject(signal.reason); return; }
      if (code !== 0) { reject(new Error((stderrBuffer.trim() || `اجرای کرالر با کد ${code} متوقف شد.`).slice(-1200))); return; }
      try {
        const result = JSON.parse(stdout) as { listingCount?:number; articles?:Article[]; outputFile?:string };
        resolve({ listingCount: result.listingCount ?? 0, verifiedArticles: result.articles?.length ?? 0, outputFile: result.outputFile ?? "" });
      } catch { reject(new Error("خروجی تست JSON معتبر نبود.")); }
    });
  }));
}
export async function runSiteFull(root: string, id: string, log: RunLogger, signal: AbortSignal) {
  await activeVersion(root, id);
  const entry = path.join(sitesRoot(root), id, "crawler.ts");
  return await log.stage("site.run", "اجرای کامل کرالر و استخراج همهٔ خبرهای فهرست", () => new Promise<{discovered:number;extracted:number;failed:number;status:string}>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "dotenv/config", "--import", "tsx", entry, "--all"], { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuffer = "", outputFile = "";
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/); stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.stage === "output.created" && typeof event.outputFile === "string") outputFile = event.outputFile;
          log.log("site.runner", "progress", String(event.message ?? event.stage ?? "پیام کرالر"), Object.fromEntries(Object.entries(event).filter(([key]) => !["message", "timestamp", "outputFile"].includes(key))));
        } catch { if (line.trim()) log.log("site.runner", "progress", line.trim().slice(0, 500)); }
      }
    });
    child.once("error", reject);
    child.once("close", async code => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) { reject(signal.reason); return; }
      try {
        if (!outputFile) throw new Error((stderrBuffer.trim() || `اجرای کرالر با کد ${code} متوقف شد.`).slice(-1200));
        const result = JSON.parse(await readFile(outputFile, "utf8")) as { discovered?:number;items?:Article[];errors?:unknown[];status?:string;failure?:string };
        if (result.status === "failed") throw new Error(result.failure || "اجرای کامل کرالر ناموفق بود.");
        const summary = { discovered: result.discovered ?? 0, extracted: result.items?.length ?? 0, failed: result.errors?.length ?? 0, status: result.status ?? (code === 0 ? "completed" : "partial") };
        if (code !== 0) log.log("site.run", "progress", "اجرا با چند خطای خبر پایان یافت؛ خبرهای موفق قابل مشاهده‌اند.", summary, "warn");
        resolve(summary);
      } catch (error) { reject(error); }
    });
  }));
}
export async function chatAboutSite(root: string, id: string, message: string, history: {role:"user"|"assistant";content:string}[], model: string|undefined, effort: ModelReasoningEffort|undefined, log: RunLogger, signal: AbortSignal) {
  const active = await activeVersion(root, id);
  const codex = new Codex({ apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY });
  const thread = codex.startThread({ workingDirectory: active.directory, skipGitRepoCheck: true, sandboxMode: "read-only", networkAccessEnabled: false, approvalPolicy: "never", model, modelReasoningEffort: effort });
  const conversation = history.slice(-8).map(item => `${item.role}: ${item.content.slice(0, 1500)}`).join("\n");
  const prompt = [
    "You are the Persian support assistant for one generated news crawler. Reply in clear Persian.",
    "Inspect recipe.json, crawler.ts and sample.json in this version when useful. Do not edit files, run network requests, expose secrets, or claim a fix was applied.",
    "Explain the current extraction strategy and diagnose the user's concern. If a code/rule change is needed, state what should change and invite the user to use the Fix and test action.",
    `Site id: ${id}. Listing URL: ${active.recipe.listingUrl}.`, conversation ? "Recent conversation:\n" + conversation : "", "Current user message:\n" + message.slice(0, 4000),
  ].filter(Boolean).join("\n\n");
  return (await runCodexWithProgress(thread, prompt, log, signal)).trim() || "پاسخی از Codex دریافت نشد.";
}
