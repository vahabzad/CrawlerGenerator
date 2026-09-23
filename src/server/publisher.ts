import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Recipe, Article } from "../crawler/recipe";
import type { RunLogger } from "./logger";
const execute = promisify(execFile);

export function siteSlug(value: string) {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  return hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "news-site";
}

// Only schema-validated data from Codex is inserted into this reviewed runtime.
export function runnerSource(recipe: Recipe) {
  return [
    'import { RecipeCrawler } from "./runtime";',
    'import type { Article, Recipe } from "./recipe";',
    'import { readFile, writeFile, mkdir } from "node:fs/promises";',
    'import { pathToFileURL, fileURLToPath } from "node:url";',
    'import { randomUUID } from "node:crypto";',
    'import path from "node:path";',
    'export const recipe: Recipe = ' + JSON.stringify(recipe, null, 2) + ';',
    'const log = (stage: string, message: string, details?: Record<string, unknown>) => console.error(JSON.stringify({timestamp:new Date().toISOString(),stage,message,...details}));',
    'const crawler = new RecipeCrawler(recipe, log);',
    'export async function crawlListing(url = recipe.listingUrl) { return crawler.crawlListing(url); }',
    'export async function crawlArticle(url: string) { return crawler.crawlArticle(url); }',
    'export async function main() {',
    '  const args = process.argv.slice(2);',
    '  if (args.includes("--help")) { console.log("Usage: tsx crawler.ts [listing-url] [--all] [--verify] [--verify-count=1..10] [--state=path] [--output=path]"); return; }',
    '  const sourceUrl = args.find(arg => !arg.startsWith("--")) || recipe.listingUrl;',
    '  const crawledAt = new Date().toISOString();',
    '  const outputFile = path.resolve(args.find(a=>a.startsWith("--output="))?.slice(9) || path.join(path.dirname(fileURLToPath(import.meta.url)), "outputs", crawledAt.replace(/[:.]/g,"-") + "-" + randomUUID() + ".json"));',
    '  const result: {sourceUrl:string;crawledAt:string;outputFile:string;mode:string;status:string;discovered:number;skippedSeen:number;listing:Article[];items:Article[];errors:{url:string;message:string}[];listingCount?:number;article?:Article;articles?:Article[];failure?:string} = {sourceUrl,crawledAt,outputFile,mode:args.includes("--verify")?"verify":args.includes("--all")?"all":"new",status:"running",discovered:0,skippedSeen:0,listing:[],items:[],errors:[]};',
    '  await mkdir(path.dirname(outputFile),{recursive:true});',
    '  await writeFile(outputFile,JSON.stringify(result,null,2),{encoding:"utf8",flag:"wx"});',
    '  const save = () => writeFile(outputFile,JSON.stringify(result,null,2),"utf8");',
    '  log("output.created","JSON output file created",{outputFile});',
    '  try {',
    '  const listing = await crawlListing(sourceUrl);',
    '  result.listing=listing; result.discovered=listing.length; await save();',
    '  if (args.includes("--verify")) {',
    '    const requested=Number(args.find(a=>a.startsWith("--verify-count="))?.slice(15) || 1);',
    '    if(!Number.isInteger(requested)||requested<1||requested>10) throw new Error("--verify-count must be between 1 and 10");',
    '    const targets=listing.slice(0,Math.min(requested,listing.length)); const articles:Article[]=[];',
    '    for(const [index,item] of targets.entries()){log("verify.article","Verifying article",{current:index+1,total:targets.length,url:item.url});articles.push(await crawlArticle(item.url));}',
    '    const article=articles[0];',
    '    Object.assign(result,{listingCount:listing.length,article,articles,items:articles,status:"completed"}); await save();',
    '    log("output.saved","JSON output saved",{outputFile}); console.log(JSON.stringify(result,null,2)); return;',
    '  }',
    '  const statePath = path.resolve(args.find(a=>a.startsWith("--state="))?.slice(8) || "crawler-state-" + new URL(sourceUrl).hostname + ".json");',
    '  let seen: string[] = [];',
    '  if (!args.includes("--all")) {',
    '    try { const data = JSON.parse(await readFile(statePath,"utf8")); if (!Array.isArray(data) || data.some(x=>typeof x!=="string")) throw new Error("Invalid seen-URL state"); seen=data; }',
    '    catch(error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }',
    '  }',
    '  const unseen = listing.filter(item=>!seen.includes(item.url));',
    '  result.skippedSeen=listing.length-unseen.length;',
    '  const {items,errors}=result; await save();',
    '  for (const item of unseen) {',
    '    try { log("article.start","Extracting article",{url:item.url,current:items.length+errors.length+1,total:unseen.length}); items.push(await crawlArticle(item.url)); }',
    '    catch(error) { const message=error instanceof Error?error.message:"Unknown error"; errors.push({url:item.url,message}); log("article.error",message,{url:item.url}); }',
    '    await save();',
    '    await new Promise(resolve=>setTimeout(resolve,350));',
    '  }',
    '  if (!args.includes("--all")) await writeFile(statePath,JSON.stringify([...new Set([...seen,...items.map(item=>item.url)])],null,2),"utf8");',
    '  result.status=errors.length?"partial":"completed"; await save();',
    '  log("output.saved","JSON output saved",{outputFile,extracted:items.length,failed:errors.length});',
    '  console.log(JSON.stringify(result,null,2));',
    '  if(errors.length) process.exitCode=1;',
    '  } catch(error) { result.status="failed"; result.failure=error instanceof Error?error.message:String(error); await save(); throw error; }',
    '}',
    'if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});',
    '',
  ].join("\n");
}

export async function publishBundle(root: string, recipe: Recipe, log: RunLogger, signal: AbortSignal) {
  const slug = siteSlug(recipe.listingUrl);
  const version = new Date().toISOString().replace(/[:.]/g, "-");
  const siteRelative = "generated/sites/" + slug;
  const relative = siteRelative + "/versions/" + version;
  const directory = path.join(root, relative);
  const source = runnerSource(recipe);
  await log.stage("output.prepare", "آماده‌سازی بستهٔ مستقل کرالر", async () => {
    await mkdir(directory, { recursive: true });
    for (const name of ["runtime.ts", "recipe.ts"]) await copyFile(path.join(root, "src/crawler", name), path.join(directory, name));
    await writeFile(path.join(directory, "crawler.ts"), source, "utf8");
    await writeFile(path.join(directory, "recipe.json"), JSON.stringify(recipe, null, 2), "utf8");
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const dependencies = Object.fromEntries(["cheerio","playwright","ipaddr.js","@msgpack/msgpack","zod","dotenv"].map(name => [name,pkg.dependencies[name]]));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "standalone-news-crawler", private: true, type: "module",
      scripts: { start: "node --import dotenv/config --import tsx crawler.ts" }, dependencies: { ...dependencies, tsx: pkg.devDependencies.tsx },
    }, null, 2), "utf8");
  });
  const sample = await log.stage("verify.live", "اجرای واقعی فایل تولیدشده: فهرست و متن خبر", async () => {
    signal.throwIfAborted();
    const heartbeat = setInterval(() => log.log("verify.live", "progress", "کرالر مستقل در حال دریافت دوبارهٔ داده‌هاست."), 10_000);
    try {
      const { stdout } = await execute(process.execPath, ["--import", "tsx", path.join(directory, "crawler.ts"), "--verify", "--verify-count=5"], {
        cwd: root, signal, timeout: 180_000, maxBuffer: 2_000_000, windowsHide: true,
      });
      const result = JSON.parse(stdout) as { listingCount: number; article: Article; articles: Article[] };
      if (!result.listingCount || !result.articles?.length || result.articles.some(article => !article.content || article.content.length < 120 || !article.contentHtml)) throw new Error("فایل تولیدشده همهٔ خبرهای آزمایشی را معتبر استخراج نکرد.");
      log.log("verify.live", "progress", "فایل مستقل با موفقیت روی چند خبر آزمایش شد.", { listingCount: result.listingCount, verifiedArticles: result.articles.length, minimumContentCharacters: Math.min(...result.articles.map(article => article.content!.length)) });
      return result;
    } catch (error) {
      // Child errors can contain huge stdout/stderr; keep only a bounded diagnostic tail.
      const stderr = (error as { stderr?: string }).stderr;
      if (stderr) log.log("verify.live", "progress", "جزئیات خطای اجرای مستقل", { diagnostic: stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 1500) }, "warn");
      throw new Error("آزمایش زندهٔ فایل تولیدشده ناموفق بود؛ نسخهٔ قبلی جایگزین نشد.", { cause: error });
    } finally { clearInterval(heartbeat); }
  });
  await log.stage("output.save", "انتشار نسخهٔ آزمایش‌شده", async () => {
    signal.throwIfAborted();
    await writeFile(path.join(directory, "sample.json"), JSON.stringify(sample, null, 2), "utf8");
    const siteDirectory = path.join(root, siteRelative);
    await mkdir(siteDirectory, { recursive: true });
    const siteEntry = path.join(siteDirectory, "crawler.ts");
    try { await copyFile(siteEntry, path.join(siteDirectory, "previous-" + version + ".ts")); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const siteWrapper = [
      'export * from "./versions/' + version + '/crawler";',
      'import { main } from "./versions/' + version + '/crawler";',
      'import { pathToFileURL } from "node:url";',
      'import path from "node:path";',
      'if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});',
    ].join("\n");
    const siteStaging = path.join(siteDirectory, "latest-" + log.requestId + ".tmp");
    await writeFile(siteStaging, siteWrapper, "utf8");
    await rename(siteStaging, siteEntry);
    const globalWrapper = [
      'export * from "./sites/' + slug + '/crawler";',
      'import { main } from "./sites/' + slug + '/crawler";',
      'import { pathToFileURL } from "node:url";',
      'import path from "node:path";',
      'if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});',
    ].join("\n");
    const globalEntry = path.join(root, "generated/crawler.ts");
    const globalStaging = path.join(root, "generated/latest-" + log.requestId + ".tmp");
    await writeFile(globalStaging, globalWrapper, "utf8");
    await rename(globalStaging, globalEntry);
  });
  return { source, file: siteRelative + "/crawler.ts", sample, strategies: { listing: recipe.listing.mode, article: recipe.article.mode } };
}
