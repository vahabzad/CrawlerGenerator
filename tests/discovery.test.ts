import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { extract, validateItems, validateArticleQuality, assertPublicUrl, normalizeTimestamp, RecipeCrawler, limitedText, browserSnapshotLooksBlocked } from "../src/crawler/runtime";
import { discoverExtractor, discoverNewsSitemap, expandListingCoverage, inferArticleUrlPattern, selectAuditUrls } from "../src/server/generator";
import { isUsableArticle, runnerSource, siteSlug } from "../src/server/publisher";
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
test("an HTTP rejection from static fetch falls back to the browser during discovery", async t => {
  const { log }=await setup(t);
  let browserCalls=0;
  const rendered={...shell,html:"<div class='news'><a href='/news/1'>First complete headline</a></div>"};
  const result=await discoverExtractor("listing",shell.url,async()=>({...htmlPlan,mode:"rendered" as const}),log,new AbortController().signal,1000,{
    html:async()=>{throw new Error("دریافت HTML ناموفق بود: HTTP 403");},
    browser:async()=>{browserCalls++;return rendered;},
  });
  assert.equal(browserCalls,1); assert.equal(result.items.length,1);
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

test("image-only news preserves gallery media and passes article validation", () => {
  const plan: Plan = { mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{
    ...fields,url:null,title:field("h1"),content:field(".gallery img"),imageUrl:null,
  }};
  const snapshot={...shell,url:"https://example.com/news/gallery",html:`<article><h1>گزارش تصویری روز</h1><div class="gallery"><img src="/one.jpg"><img data-src="/two.jpg"></div></article>`};
  const article=validateItems(extract(snapshot,plan,"article"),"article")[0];
  assert.equal(article.content,null);
  assert.match(article.contentHtml!,/src="https:\/\/example.com\/one.jpg"/);
  assert.match(article.contentHtml!,/src="https:\/\/example.com\/two.jpg"/);
  assert.equal(validateArticleQuality(article,snapshot,plan),article);
});

test("a title and single hero image cannot pass as a complete text article", () => {
  const article={url:"https://example.com/culture/article/story",title:"Feature title",content:"Photo credit",contentHtml:'<figure><img src="https://example.com/hero.jpg"></figure>',publishedAt:null,summary:null,imageUrl:"https://example.com/hero.jpg",categories:[],tags:[],author:null};
  assert.throws(()=>validateItems([article],"article"),/متن کامل/);
  assert.equal(isUsableArticle(article),false);
});

test("a short reel description with its verified poster remains valid multimedia", () => {
  const article={url:"https://example.com/reel/video/p0video1/watch",title:"Video feature",content:"A concise description of this BBC video report.",contentHtml:"<p>A concise description of this BBC video report.</p>",publishedAt:null,summary:null,imageUrl:"https://example.com/poster.jpg",categories:[],tags:[],author:null};
  assert.doesNotThrow(()=>validateItems([article],"article"));
  assert.equal(isUsableArticle(article),true);
});

test("overlapping article roots retain the richest extraction", () => {
  const full="Complete article paragraph with meaningful reporting. ".repeat(12);
  const plan:Plan={mode:"html",root:"main, main article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field("[data-component]")}};
  const snapshot={...shell,url:"https://example.com/culture/article/story",html:`<main><h1>Feature title</h1><div data-component="text-block"><p>${full}</p></div><article><h1>Feature title</h1><div data-component="image-block"><img src="/hero.jpg"></div></article></main>`};
  const article=validateItems(extract(snapshot,plan,"article"),"article")[0];
  assert.match(article.content!,/Complete article paragraph/);
  assert.ok(article.content!.length>500);
});

test("multimedia news with a short caption is not rejected as incomplete text", () => {
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body")}};
  const snapshot={...shell,url:"https://example.com/news/video",html:`<article><h1>گزارش ویدیویی</h1><div class="body"><p>${"توضیح کوتاه ویدیو ".repeat(9)}</p><video src="/clip.mp4" controls></video></div><aside>${"متن جانبی ".repeat(100)}</aside></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.match(article.contentHtml!,/<video/); assert.equal(validateArticleQuality(article,snapshot,plan),article);
  assert.equal(isUsableArticle(article),true);
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

test("section metadata fills categories separately from topic tags", () => {
  const full="Complete article body text for category validation. ".repeat(20);
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body")}};
  const snapshot={...shell,url:"https://example.com/news/1",html:`<head><meta property="cXenseParse:recs:section" content="Technology"><meta name="keywords" content="Artificial intelligence, Data breaches"></head><article><h1>Technology report</h1><div class="body"><p>${full}</p></div></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.deepEqual(article.categories,["Technology"]);
  assert.deepEqual(article.tags,["Artificial intelligence","Data breaches"]);
  assert.equal(validateArticleQuality(article,snapshot,plan),article);
});

test("quality validation rejects missing classification that exists in metadata", () => {
  const full="Complete article body text for category validation. ".repeat(20);
  const plan:Plan={mode:"html",root:"article",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body")}};
  const snapshot={...shell,url:"https://example.com/news/1",html:`<head><meta name="page.section" content="World"><meta name="keywords" content="Climate"></head><article><h1>World report</h1><div class="body"><p>${full}</p></div></article>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.throws(()=>validateArticleQuality({...article,categories:[]},snapshot,plan),/دسته‌بندی/);
  assert.throws(()=>validateArticleQuality({...article,tags:[]},snapshot,plan),/برچسب/);
});

test("structured video metadata keeps short video news as a valid media article", () => {
  const plan:Plan={mode:"html",root:"html",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field(".text-article h1"),content:field(".text-article .body"),author:field(".text-article .author"),imageUrl:field(".text-article img","src")}};
  const description="Persistent heavy downpours triggered widespread flooding and severe traffic disruption across the city.";
  const snapshot={...shell,url:"https://example.com/video/newsfeed/2026/9/26/floods",html:`<head><script type="application/ld+json">${JSON.stringify({"@type":"VideoObject",name:"Flooding video report",uploadDate:"2026-09-26T04:43:39Z",description,thumbnailUrl:"/thumb.jpg"})}</script></head><body><main><h1>Flooding video report</h1></main></body>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.equal(article.title,"Flooding video report"); assert.equal(article.content,description);
  assert.equal(article.publishedAt,"2026-09-26T04:43:39.000Z"); assert.equal(article.imageUrl,"https://example.com/thumb.jpg");
  assert.match(article.contentHtml!,/<img src="https:\/\/example.com\/thumb.jpg">/);
  assert.equal(validateArticleQuality(article,snapshot,plan),article);
});

test("article structure validation ignores text blocks outside the selected body", () => {
  const plan:Plan={mode:"html",root:".page",responseUrlIncludes:null,urlPattern:null,explanation:"test",fields:{...fields,url:null,title:field("h1"),content:field(".body")}};
  const body=`<div class="body"><p>${"متن اصلی خبر ".repeat(20)}</p><p>${"ادامه خبر ".repeat(20)}</p></div>`;
  const sidebar=Array.from({length:7},(_,i)=>`<p>مطلب جانبی شماره ${i} با متن کافی</p>`).join("");
  const snapshot={...shell,url:"https://example.com/news/1",html:`<div class="page"><h1>عنوان خبر</h1>${body}<aside>${sidebar}</aside></div>`};
  const article=extract(snapshot,plan,"article")[0];
  assert.equal(validateArticleQuality(article,snapshot,plan),article);
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

test("standalone crawler falls back to rendered content when static fetch is forbidden", async () => {
  const rendered={...shell,html:"<div class='news'><a href='/news/1'>First complete headline</a></div>"};
  let browserCalls=0;
  const crawler=new RecipeCrawler({listingUrl:shell.url,listing:htmlPlan,article:htmlPlan,browserWaitMs:1000},()=>{}, {
    html:async()=>{throw new Error("HTTP 403");},
    browser:async()=>{browserCalls++;return rendered;},
  });
  const items=await crawler.crawlListing(shell.url,new AbortController().signal);
  assert.equal(browserCalls,1); assert.equal(items.length,1);
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
test("responses above the HTML safety cap are truncated instead of aborting crawler generation", async () => {
  const response = new Response("<main>" + "x".repeat(100) + "</main>");
  const html = await limitedText(response, 32);
  assert.equal(Buffer.byteLength(html), 32);
  assert.match(html, /^<main>x+$/);
});
test("tiny anti-bot browser responses are rejected but sparse structured stories are retained", () => {
  assert.equal(browserSnapshotLooksBlocked({...shell,html:"<html><body>Access denied</body></html>"}),true);
  assert.equal(browserSnapshotLooksBlocked({...shell,html:`<script type="application/ld+json">${JSON.stringify({"@type":"VideoObject",name:"Video report",description:"A real structured video story"})}</script>`}),false);
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

test("emitted runner merges listing snapshots and retries transient article failures", async t => {
  const { directory } = await setup(t);
  await writeFile(path.join(directory,"package.json"),'{"type":"module"}');
  await writeFile(path.join(directory,"crawler.ts"),runnerSource({listingUrl:shell.url,listing:htmlPlan,article:htmlPlan,browserWaitMs:1000}));
  await writeFile(path.join(directory,"runtime.ts"),[
    'let attempts=0,listingAttempts=0;',
    'export class RecipeCrawler {',
    'async crawlListing(){listingAttempts++;return listingAttempts===1?[{url:"https://example.com/news/1",title:"خبر ۱"}]:[{url:"https://example.com/news/1",title:"خبر ۱"},{url:"https://example.com/news/2",title:"خبر ۲"}]}',
    'async crawlArticle(url){attempts++;if(attempts===1)throw new Error("متن کامل یا محتوای تصویری خبر استخراج نشده است.");if(attempts===2)throw new Error("net::ERR_CONNECTION_RESET");return {url,title:"خبر",content:"متن کامل خبر"}}',
    '}',
  ].join("\n"));
  const result=JSON.parse((await promisify(execFile)(process.execPath,["--import",import.meta.resolve("tsx"),path.join(directory,"crawler.ts"),"--all"],{cwd:directory,windowsHide:true})).stdout);
  assert.equal(result.listing.length,2); assert.equal(result.items.length,2); assert.equal(result.errors.length,0); assert.equal(result.status,"completed");
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

test("dated article slugs expand a narrow live-news widget to the complete page", () => {
  const links=Array.from({length:30},(_,index)=>`<section class="${index<4?"ticker":"homepage-card"}"><a href="/en/${index%3===0?"europe":index%3===1?"americas":"live-news"}/20260926-story-${index}">Complete story headline ${index}</a></section>`).join("");
  const snapshot:Snapshot={url:"https://www.france24.com/en/",html:links,apis:[]};
  const narrow:Plan={...htmlPlan,root:".ticker",urlPattern:"^/en/(?:[^/]+)/[0-9]{8}-[^/]+$",fields:{...fields,url:field("a","href"),title:field("a")}};
  const initial={plan:narrow,snapshot,items:validateItems(extract(snapshot,narrow,"listing"),"listing")};
  assert.equal(initial.items.length,4);
  assert.equal(inferArticleUrlPattern(initial.items[0].url,snapshot),"^/en/[^/]+/\\d{8}-[^/]+/?$");
  const expanded=expandListingCoverage(initial,initial.items[0].url);
  assert.equal(expanded.items.length,30); assert.equal(expanded.plan.root,"a[href]");
});

test("coverage census includes distinct article, reel video and audio route families", () => {
  const links=[
    ...Array.from({length:4},(_,i)=>`<a href="/news/articles/c12345${i}"><h2>Regular news headline ${i}</h2></a>`),
    ...Array.from({length:3},(_,i)=>`<a href="/audio/play/p0audio${i}"><h2>Audio episode headline ${i}</h2></a>`),
    ...Array.from({length:2},(_,i)=>`<a href="/reel/video/p0video${i}/watch"><h2>Video feature headline ${i}</h2></a>`),
    `<a href="/newsletters"><h2>Newsletter promotion</h2></a><a href="/video/docs"><h2>Documentaries landing page</h2></a>`,
  ].join("");
  const snapshot:Snapshot={url:"https://www.bbc.com/",html:links,apis:[]};
  const narrow:Plan={...htmlPlan,root:"a[href]",urlPattern:"^/news/articles/[a-z0-9]+$",fields:{...fields,url:field(".","href"),title:field(".")}};
  const initial={plan:narrow,snapshot,items:validateItems(extract(snapshot,narrow,"listing"),"listing")};
  const expanded=expandListingCoverage(initial,initial.items[0].url);
  assert.equal(initial.items.length,4);
  assert.equal(expanded.items.length,9);
  assert.ok(expanded.items.some(item=>item.url.includes("/audio/play/")));
  assert.ok(expanded.items.some(item=>item.url.includes("/reel/video/")));
  assert.ok(!expanded.items.some(item=>item.url.endsWith("/newsletters")||item.url.endsWith("/video/docs")));
});

test("listing discovery rejects partial coverage and gives Codex the expected count", async t => {
  const { log }=await setup(t);
  const links=Array.from({length:30},(_,index)=>`<section class="${index<4?"ticker":"card"}"><a href="/en/${index%2?"world":"europe"}/20260926-story-${index}">Complete story headline ${index}</a></section>`).join("");
  const snapshot:Snapshot={url:"https://example.com/en/",html:links,apis:[]};
  const pattern="^/en/[^/]+/[0-9]{8}-[^/]+$";
  const narrow:Plan={...htmlPlan,root:".ticker",urlPattern:pattern,fields:{...fields,url:field("a","href"),title:field("a")}};
  const complete:Plan={...htmlPlan,root:"a[href]",urlPattern:pattern,fields:{...fields,url:field(".","href"),title:field(".")}};
  const prompts:string[]=[];
  const result=await discoverExtractor("listing",snapshot.url,async prompt=>{prompts.push(prompt);return prompts.length===1?narrow:complete;},log,new AbortController().signal,1000,{html:async()=>snapshot,browser:async()=>{throw new Error("browser should not be needed");}});
  assert.equal(prompts.length,2); assert.match(prompts[1],/فقط 4 خبر از حداقل 30/); assert.equal(result.items.length,30);
  await log.flush();
});

test("inferred wildcard article routes exclude taxonomy URLs and audits sample the full listing", () => {
  const links=["/writer/123456/article","/topic/123457/world","/hashtag/123458/news"].map((href,index)=>`<a href="${href}">عنوان ${index}</a>`).join("");
  const snapshot:Snapshot={url:"https://example.com/",html:links,apis:[]};
  const pattern=inferArticleUrlPattern("https://example.com/writer/123456/article",snapshot)!;
  assert.match("/writer/123456/article",new RegExp(pattern));
  assert.doesNotMatch("/topic/123457/world",new RegExp(pattern));
  assert.doesNotMatch("/hashtag/123458/news",new RegExp(pattern));
  const items=Array.from({length:40},(_,index)=>({url:`https://example.com/writer/${100000+index}`,title:index===31?"گزارش ویدیویی":"خبر عادی",content:null,contentHtml:null,publishedAt:null,summary:null,imageUrl:null,categories:[],tags:[],author:null}));
  const audit=selectAuditUrls(items,items[0].url,8);
  assert.equal(audit.length,8); assert.ok(audit.includes(items[31].url)); assert.ok(audit.some(url=>Number(url.split("/").pop())>100020));
});

test("declared news sitemaps expand a homepage beyond its visible article anchors", async t => {
  const { log }=await setup(t);
  const origin="https://example.com";
  const xml=`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${Array.from({length:40},(_,index)=>`<url><loc>${origin}/news/2026/9/23/story-${index}</loc><lastmod>2026-09-23T12:${String(index).padStart(2,"0")}:00Z</lastmod><news:news><news:title>Story ${index}</news:title></news:news></url>`).join("")}</urlset>`;
  const fetcher:typeof import("../src/crawler/runtime").fetchSnapshot=async url=>({url,html:url.endsWith("robots.txt")?`Sitemap: ${origin}/news-sitemap.xml`:xml,apis:[]});
  const result=await discoverNewsSitemap(origin+"/",log,new AbortController().signal,fetcher);
  assert.equal(result?.items.length,40); assert.equal(result?.snapshot.url,origin+"/news-sitemap.xml");
  assert.equal(result?.items[0].title,"Story 0"); assert.equal(result?.items[0].publishedAt,"2026-09-23T12:00:00.000Z");
  await log.flush();
});

test("a generic sitemap index declared by robots discovers its nested news sitemap", async t => {
  const { log }=await setup(t);
  const origin="https://example.com";
  const index=`<sitemapindex><sitemap><loc>${origin}/sitemap/pages.xml</loc></sitemap><sitemap><loc>${origin}/sitemap/sitemap-news.xml</loc></sitemap></sitemapindex>`;
  const news=`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${Array.from({length:30},(_,index)=>`<url><loc>${origin}/story/story-${index}</loc><news:news><news:title>News ${index}</news:title></news:news></url>`).join("")}</urlset>`;
  const calls:string[]=[];
  const fetcher:typeof import("../src/crawler/runtime").fetchSnapshot=async url=>{
    calls.push(url);
    const html=url.endsWith("robots.txt")?`Sitemap: ${origin}/sitemap.xml`:url.endsWith("sitemap.xml")?index:url.endsWith("sitemap-news.xml")?news:"<urlset/>";
    return {url,html,apis:[]};
  };
  const result=await discoverNewsSitemap(origin+"/",log,new AbortController().signal,fetcher);
  assert.equal(result?.items.length,30);
  assert.equal(result?.snapshot.url,origin+"/sitemap/sitemap-news.xml");
  assert.ok(calls.includes(origin+"/sitemap.xml"));
  await log.flush();
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
