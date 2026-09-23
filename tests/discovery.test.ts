import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { extract, validateItems, validateArticleQuality, assertPublicUrl, normalizeTimestamp, RecipeCrawler } from "../src/crawler/runtime";
import { discoverExtractor, expandListingCoverage, inferArticleUrlPattern } from "../src/server/generator";
import { runnerSource, siteSlug } from "../src/server/publisher";
import { RunLogger } from "../src/server/logger";
import type { Plan, Snapshot } from "../src/crawler/recipe";

const field = (path: string, attribute: string | null = null, template: string | null = null) => ({ path, attribute, template });
const fields = { url: field("url"), title: field("title"), content: null, publishedAt: null, summary: null, imageUrl: null, categories: null, tags: null, author: null };
const apiPlan: Plan = { mode: "api", root: "data.news.*", responseUrlIncludes: "/api/news", urlPattern: null, fields, explanation: "test" };
const htmlPlan: Plan = { mode: "html", root: ".news", responseUrlIncludes: null, urlPattern: null, fields: { ...fields, url: field("a","href"), title: field("a") }, explanation: "test" };
const shell: Snapshot = { url: "https://example.com/news", html: "<html><body><div id='app'></div></body></html>", apis: [] };
const browser: Snapshot = { ...shell, apis: [{ url: "https://example.com/api/news", data: { data: { news: [{ url: "/news/1", title: "First real news" }, { url: "/news/2", title: "Second real news" }] } } }] };
async function setup(t: import("node:test").TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "crawler-discovery-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {}); t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  return { directory, log: new RunLogger("test", directory, () => {}) };
}
test("usable static HTML avoids the browser", async t => {
  const { log } = await setup(t);
  let browserCalls = 0;
  const snapshot = { ...shell, html: "<div class='news'><a href='/news/1'>First real news</a></div>" };
  const result = await discoverExtractor("listing", shell.url, async () => htmlPlan, log, new AbortController().signal, 1000, {
    html: async () => snapshot, browser: async () => { browserCalls++; return browser; },
  });
  assert.equal(result.items.length, 1); assert.equal(browserCalls, 0);
  await log.flush();
});
test("an empty HTML shell falls back to captured APIs before asking Codex", async t => {
  const { log } = await setup(t);
  let captured = false;
  const result = await discoverExtractor("listing", shell.url, async prompt => {
    assert.ok(captured); assert.match(prompt, /api\/news/); return apiPlan;
  }, log, new AbortController().signal, 1000, {
    html: async () => shell, browser: async () => { captured = true; return browser; },
  });
  assert.equal(result.plan.mode, "api"); assert.equal(result.items.length, 2);
  await log.flush();
});
test("a bad HTML extraction is repaired then falls back rather than publishing empty items", async t => {
  const { log } = await setup(t);
  let calls = 0;
  const result = await discoverExtractor("listing", shell.url, async () => {
    calls++; return calls <= 2 ? { ...htmlPlan, root: ".missing" } : apiPlan;
  }, log, new AbortController().signal, 1000, {
    html: async () => ({ ...shell, html: "<a href='/news/1'>Long enough link title</a>" }), browser: async () => browser,
  });
  assert.equal(calls, 3); assert.equal(result.items.length, 2);
  await log.flush();
});
test("article API extraction resolves dynamic URLs and strips HTML from full body", () => {
  const plan: Plan = { ...apiPlan, root: "data", fields: { ...fields, url: field("id", null, "{origin}/news/{id}"), content: field("body") } };
  const snapshot = { ...shell, apis: [{ url: "https://example.com/api/news", data: { data: { id: "1234567890123456789", title: "Article title", body: "<p>" + "محتوای کامل خبر ".repeat(20) + "</p>" } } }] };
  const article = validateItems(extract(snapshot, plan, "article"), "article")[0];
  assert.equal(article.url, "https://example.com/news/1234567890123456789"); assert.ok(!article.content?.includes("<p>"));
  assert.match(article.contentHtml!, /<p>/); assert.deepEqual(article.categories, []); assert.deepEqual(article.tags, []);
});
test("empty lists and summary-only articles fail validation explicitly", () => {
  assert.throws(() => validateItems([], "listing"), /خالی/);
  assert.throws(() => validateItems([{ url: shell.url, title: "Article", content: "short", contentHtml: "<p>short</p>", summary: null, publishedAt: null, imageUrl: null, categories: [], tags: [], author: null }], "article"), /متن کامل/);
});

test("article output preserves safe HTML links/images and separates metadata arrays", () => {
  const plan: Plan = { mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{
    ...fields,url:null,title:field("h1"),content:field(".body"),imageUrl:null,publishedAt:field("time"),
    categories:field(".category"),tags:field(".tag"),author:field(".author"),
  }};
  const snapshot={...shell,url:"https://example.com/news/one",html:`<article><h1>عنوان کامل خبر</h1><time>2026-08-31T10:00:00Z</time><span class="author">خبرنگار نمونه</span><a class="category">اجتماعی</a><a class="category">اقتصاد</a><i class="tag">تهران</i><i class="tag">شهرداری</i><div class="body"><p>${"متن کامل خبر ".repeat(20)} <a href="/source">منبع</a></p><img data-src="/photo.jpg" onerror="bad()"><script>bad()</script></div></article>`};
  const article=validateItems(extract(snapshot,plan,"article"),"article")[0];
  assert.deepEqual(article.categories,["اجتماعی","اقتصاد"]); assert.deepEqual(article.tags,["تهران","شهرداری"]);
  assert.equal(article.author,"خبرنگار نمونه"); assert.equal(article.publishedAt,"2026-08-31T10:00:00.000Z");
  assert.equal(article.imageUrl,"https://example.com/photo.jpg"); assert.match(article.contentHtml!,/href="https:\/\/example.com\/source"/);
  assert.match(article.contentHtml!,/<div class="body">/); assert.match(article.contentHtml!,/<p>/);
  assert.match(article.contentHtml!,/src="https:\/\/example.com\/photo.jpg"/); assert.doesNotMatch(article.contentHtml!,/script|onerror/);
  assert.equal(validateArticleQuality(article,snapshot,plan),article);
});

test("structured article metadata overrides a wrong image and fills publication fields", () => {
  const full="متن کامل و معتبر خبر ".repeat(30);
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body"),imageUrl:field(".wrong","src")}};
  const snapshot={...shell,url:"https://example.com/news/1",html:`<head><meta property="og:image" content="/correct.jpg"><meta property="article:published_time" content="2026-09-01T08:00:00Z"><meta name="author" content="نویسنده معتبر"><script type="application/ld+json">${JSON.stringify({"@type":"NewsArticle",headline:"عنوان خبر",articleBody:full,image:"/correct.jpg",datePublished:"2026-09-01T08:00:00Z",author:{name:"نویسنده معتبر"},articleSection:["اقتصاد"],keywords:"بورس, بازار"})}</script></head><article><h1>عنوان خبر</h1><img class="wrong" src="/wrong.jpg"><div class="body"><p>${full}</p></div></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.equal(article.imageUrl,"https://example.com/correct.jpg"); assert.equal(article.author,"نویسنده معتبر");
  assert.equal(article.publishedAt,"2026-09-01T08:00:00.000Z"); assert.deepEqual(article.categories,["اقتصاد"]); assert.deepEqual(article.tags,["بورس","بازار"]);
});

test("an author profile URL is not accepted as the author's name", () => {
  const full="متن کامل خبر ".repeat(30);
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body"),author:field(".author")}};
  const snapshot={...shell,url:"https://example.com/news/1",html:`<script type="application/ld+json">${JSON.stringify({"@type":"NewsArticle",author:"https://example.com/reporters/one"})}</script><article><h1>عنوان خبر</h1><span class="author">نام خبرنگار</span><div class="body">${full}</div></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.equal(article.author,"نام خبرنگار"); assert.equal(validateArticleQuality(article,snapshot,plan),article);
});

test("quality validation rejects a selector that captures only a small part of the article", () => {
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".first")}};
  const snapshot={...shell,url:"https://example.com/news/1",html:`<article><h1>عنوان خبر</h1><div class="first">${"ابتدای خبر ".repeat(15)}</div><div>${"ادامه کامل خبر ".repeat(100)}</div></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.throws(()=>validateArticleQuality(article,snapshot,plan),/ناقص/);
});

test("standalone crawler falls back from an empty HTML shell to rendered content", async () => {
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body")}};
  const rendered={...shell,url:"https://example.com/news/1",html:`<article><h1>عنوان خبر آزمایشی</h1><div class="body"><p>${"متن کامل خبر برای آزمایش fallback ".repeat(20)}</p></div></article>`};
  let browserCalls=0;
  const crawler=new RecipeCrawler({listingUrl:shell.url,listing:htmlPlan,article:plan,browserWaitMs:1000},()=>{}, {
    html:async()=>shell,
    browser:async(_url,_signal,_wait,_observe,until)=>{browserCalls++; assert.equal(until?.(rendered),true); return rendered;},
  });
  const article=await crawler.crawlArticle(rendered.url,new AbortController().signal);
  assert.equal(browserCalls,1); assert.match(article.content!,/fallback/); assert.match(article.contentHtml!,/<p>/);
});

test("publication dates normalize to ISO timestamps and site folders use hostnames", () => {
  assert.equal(normalizeTimestamp("1725100000"),"2024-08-31T10:26:40.000Z");
  assert.equal(normalizeTimestamp("2026-08-31T10:00:00Z"),"2026-08-31T10:00:00.000Z");
  assert.match(normalizeTimestamp("12:33 - 8 شهریور 1405")!,/^2026-08-(29|30)T/);
  assert.equal(siteSlug("https://www.farsnews.ir/social/showcase"),"farsnews-ir");
});
test("public URL guard rejects private IPv4 and mapped IPv6", async () => {
  for (const url of ["http://127.0.0.1","http://10.0.0.1","http://[::1]","http://[::ffff:127.0.0.1]","file:///tmp/test"]) await assert.rejects(assertPublicUrl(url));
});
test("emitted runner saves the entire list and more than ten articles, respecting seen URLs", async t => {
  const { directory } = await setup(t);
  const recipe = { listingUrl: shell.url, listing: htmlPlan, article: htmlPlan, browserWaitMs: 1000 };
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await writeFile(path.join(directory, "crawler.ts"), runnerSource(recipe));
  await writeFile(path.join(directory, "runtime.ts"), [
    "export class RecipeCrawler {",
    "async crawlListing(){return Array.from({length:12},(_,i)=>({url:'https://example.com/news/'+i,title:'خبر '+i}))}",
    "async crawlArticle(url){return {url,title:'خبر آزمایشی',content:'متن کامل خبر'}}",
    "}",
  ].join("\n"));
  const command = [ "--import", import.meta.resolve("tsx"), path.join(directory,"crawler.ts"), "--state=" + path.join(directory,"state.json") ];
  const run = async (args: string[] = []) => JSON.parse((await promisify(execFile)(process.execPath, [...command, ...args], {cwd:directory, windowsHide:true})).stdout);
  const first = await run();
  assert.equal(first.items.length, 12); assert.equal(first.listing.length, 12);
  assert.equal(first.status,"completed");
  assert.deepEqual(JSON.parse(await readFile(first.outputFile,"utf8")),first);
  const second=await run();
  assert.equal(second.items.length,0); assert.equal(second.listing.length,12); assert.equal(second.skippedSeen,12);
  assert.notEqual(second.outputFile,first.outputFile);
  assert.equal((await run(["--all"])).items.length,12);
  assert.equal(JSON.parse(await readFile(path.join(directory,"state.json"),"utf8")).length,12);
  const customFile=path.join(directory,"custom","verify.json");
  const verified=await run(["--verify","--verify-count=5","--output="+customFile]);
  assert.equal(verified.listingCount,12); assert.equal(verified.items.length,5); assert.equal(verified.articles.length,5);
  assert.deepEqual(JSON.parse(await readFile(customFile,"utf8")),verified);
  await assert.rejects(run(["--verify","--output="+customFile]),/EEXIST/);
  assert.equal((await readdir(path.join(directory,"outputs"))).length,3);
});

test("all matching listing cards are retained beyond the previous 500-card cap", () => {
  const html=Array.from({length:501},(_,i)=>`<div class="news"><a href="/news/${i}">News item ${i}</a></div>`).join("");
  assert.equal(extract({...shell,html},htmlPlan,"listing").length,501);
});

test("article URL shape expands a narrow widget to every news link on the page", () => {
  const links=Array.from({length:225},(_,index)=>`<section class="${index<53?"latest":"other"}"><a href="/fa/news/${9_000_000+index}/sample-${index}">خبر شماره ${index}</a></section>`).join("");
  const snapshot:Snapshot={url:"https://www.yjc.ir/",html:links+`<a href="/fa/profile/1234567/person">پروفایل کاربر</a>`,apis:[]};
  const narrow:Plan={...htmlPlan,root:".latest",fields:{...fields,url:field("a","href"),title:field("a")}};
  const initial={plan:narrow,snapshot,items:validateItems(extract(snapshot,narrow,"listing"),"listing")};
  assert.equal(initial.items.length,53);
  const pattern=inferArticleUrlPattern("https://www.yjc.ir/fa/news/9000000/sample-0",snapshot);
  assert.equal(pattern,"^/fa/news/\\d+(?:/[^/]+)*/?$");
  const expanded=expandListingCoverage(initial,"https://www.yjc.ir/fa/news/9000000/sample-0");
  assert.equal(expanded.items.length,225); assert.equal(expanded.plan.root,"a[href]");
  assert.ok(expanded.items.every(item=>item.url.includes("/fa/news/")));
});

test("partial and fatal failures keep diagnostic JSON and do not mark failed URLs seen", async t => {
  const { directory }=await setup(t);
  await writeFile(path.join(directory,"package.json"),'{"type":"module"}');
  await writeFile(path.join(directory,"crawler.ts"),runnerSource({listingUrl:shell.url,listing:htmlPlan,article:htmlPlan,browserWaitMs:1000}));
  await writeFile(path.join(directory,"runtime.ts"),[
    'export class RecipeCrawler {',
    'async crawlListing(){if(process.env.FIXTURE_FAIL_LIST) throw new Error("listing failed");return [{url:"https://example.com/good"},{url:"https://example.com/bad"}]}',
    'async crawlArticle(url){if(url.endsWith("bad"))throw new Error("article failed");return {url,title:"خبر",content:"متن خبر"}}',
    '}',
  ].join("\n"));
  const output=path.join(directory,"result.json");
  const state=path.join(directory,"state.json");
  const command=["--import",import.meta.resolve("tsx"),path.join(directory,"crawler.ts"),"--state="+state,"--output="+output];
  await assert.rejects(promisify(execFile)(process.execPath,command,{cwd:directory,windowsHide:true}),error=>(error as {code?:number}).code===1);
  const result=JSON.parse(await readFile(output,"utf8"));
  assert.equal(result.status,"partial"); assert.equal(result.listing.length,2); assert.equal(result.items.length,1); assert.equal(result.errors.length,1);
  assert.deepEqual(JSON.parse(await readFile(state,"utf8")),["https://example.com/good"]);
  const failed=path.join(directory,"failed.json");
  await assert.rejects(promisify(execFile)(process.execPath,[...command.slice(0,-1),"--output="+failed],{cwd:directory,windowsHide:true,env:{...process.env,FIXTURE_FAIL_LIST:"1"}}));
  const failure=JSON.parse(await readFile(failed,"utf8"));
  assert.equal(failure.status,"failed"); assert.equal(failure.failure,"listing failed");
});
