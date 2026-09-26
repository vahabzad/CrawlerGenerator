import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import ipaddr from "ipaddr.js";
import { decode } from "@msgpack/msgpack";
import type { ApiEvidence, Article, Kind, Observer, Plan, Recipe, Snapshot } from "./recipe";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const noop: Observer = () => {};
// Keep the full document for extraction and coverage checks. Evidence sent to
// Codex is bounded separately in server/evidence.ts.
const MAX_HTML = 16_000_000;
const TEMP_BROWSER_PROFILE = path.join(tmpdir(), "crawler-generator-browser-" + process.pid);
const PUBLIC_DNS_TTL_MS = 5 * 60_000;
const publicDnsCache = new Map<string, { expiresAt: number; addresses: Array<{ address: string }> }>();

export async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("فقط URL عمومی HTTP/HTTPS بدون نام کاربری و رمز مجاز است.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string }>;
  if (ipaddr.isValid(host)) addresses = [{ address: host }];
  else {
    const cached = publicDnsCache.get(host);
    if (cached && cached.expiresAt > Date.now()) addresses = cached.addresses;
    else {
      addresses = await lookup(host, { all: true });
      // A complete crawl may fetch hundreds of pages from one host. Reusing a
      // recently validated public answer prevents resolver throttling/sinkhole
      // responses from turning the tail of that crawl into false SSRF errors.
      publicDnsCache.set(host, { expiresAt: Date.now() + PUBLIC_DNS_TTL_MS, addresses });
    }
  }
  if (!addresses.length || addresses.some(({ address }) => {
    const parsed = ipaddr.process(address);
    return parsed.range() !== "unicast";
  })) throw new Error("دسترسی به آدرس محلی یا خصوصی مجاز نیست.");
  return url;
}

export async function limitedText(response: globalThis.Response, maximum: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maximum - total;
      if (remaining <= 0) break;
      buffers.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.length, remaining);
      if (value.length > remaining) break;
    }
    return Buffer.concat(buffers).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function fetchSnapshot(value: string, signal: AbortSignal, observe: Observer = noop): Promise<Snapshot> {
  let url = value;
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    observe("html", "پاسخ HTML دریافت شد.", { httpStatus: response.status });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("پاسخ تغییر مسیر بدون آدرس مقصد بود.");
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("دریافت HTML ناموفق بود: HTTP " + response.status);
    }
    const html = await limitedText(response, MAX_HTML);
    observe("html", "HTML آمادهٔ بررسی است.", { characters: html.length });
    return { url, html, apis: [] };
  }
  throw new Error("تعداد تغییر مسیرهای صفحه بیش از حد مجاز است.");
}

export function jsonValues(value: unknown, path: string): unknown[] {
  if (!path || path === "$" || path === ".") return [value];
  let values = [value];
  const parts = path.replace(/^\$\.?/, "").split(".");
  for (const part of parts) {
    if (["__proto__", "prototype", "constructor"].includes(part)) throw new Error("مسیر داده مجاز نیست.");
    values = values.flatMap(node => {
      if (part === "*") return Array.isArray(node) ? node : [];
      if (node && typeof node === "object" && Object.hasOwn(node, part)) return [(node as Record<string, unknown>)[part]];
      return [];
    });
  }
  return values;
}

export function embeddedData(html: string): ApiEvidence[] {
  const $ = cheerio.load(html);
  return $("script").toArray().flatMap((node, index) => {
    const raw = $(node).text().trim();
    if (!raw.startsWith("{") && !raw.startsWith("[")) return [];
    try { return [{ url: "embedded:" + ($(node).attr("id") || $(node).attr("type") || index), data: JSON.parse(raw) }]; }
    catch { return []; }
  });
}

function clean(value: unknown): string | null {
  const raw = Array.isArray(value) ? value.filter(v => typeof v === "string" || typeof v === "number").join("\n\n") :
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!raw) return null;
  const $ = cheerio.load(raw, null, false);
  $("script,style,noscript").remove();
  $("p,br,div,li,h2,h3").each((_, node) => { $(node).append("\n"); });
  const text = $.root().text().replace(/[ \t\r\u00a0]+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  return text || null;
}
function primitiveValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(primitiveValues) : [value];
}
function uniqueText(value: unknown): string[] {
  return [...new Set(primitiveValues(value).map(clean).filter((item): item is string => Boolean(item)))];
}
function absolute(value: string | null, base: string) {
  if (!value) return null;
  try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) ? url.href.split("#")[0] : null; }
  catch { return null; }
}

function safeHtml(value: unknown, base: string): string | null {
  const raw = primitiveValues(value).filter(v => typeof v === "string" || typeof v === "number").map(String).filter(Boolean);
  if (!raw.length) return null;
  const looksLikeHtml = raw.some(item => /<\/?[a-z][\s\S]*>/i.test(item));
  const source = looksLikeHtml ? raw.join("\n") : raw.map(item => `<p>${item.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)}</p>`).join("\n");
  const $ = cheerio.load(source, null, false);
  $("script,style,noscript,iframe,object,embed,form").remove();
  $("*").each((_, element) => {
    const node = $(element);
    for (const name of Object.keys(node.attr() ?? {})) {
      if (/^on/i.test(name) || name === "srcdoc") node.removeAttr(name);
    }
    const lazySource = node.attr("data-src") || node.attr("data-original") || node.attr("data-lazy-src");
    if (node.is("img") && !node.attr("src") && lazySource) node.attr("src", lazySource);
    for (const name of ["href", "src", "poster"]) {
      const current = node.attr(name);
      if (!current) continue;
      try {
        const url = new URL(current, base);
        if (["http:", "https:"].includes(url.protocol)) node.attr(name, url.href);
        else node.removeAttr(name);
      } catch { node.removeAttr(name); }
    }
    const srcset = node.attr("srcset");
    if (srcset) node.attr("srcset", srcset.split(",").map(part => {
      const [candidate, ...descriptor] = part.trim().split(/\s+/);
      try { return [new URL(candidate, base).href, ...descriptor].join(" "); } catch { return ""; }
    }).filter(Boolean).join(", "));
  });
  const html = $.html().trim();
  return clean(html) || hasContentMedia(html) ? html : null;
}

function hasContentMedia(html: string | null): boolean {
  if (!html) return false;
  const $ = cheerio.load(html, null, false);
  return $("img[src],video[src],video source[src],audio[src],audio source[src],picture source[src]").length > 0;
}

function hasStandaloneArticleMedia(article: Pick<Article, "url" | "contentHtml" | "imageUrl">): boolean {
  if (!article.contentHtml) return false;
  const $ = cheerio.load(article.contentHtml, null, false);
  if ($("video[src],video source[src],audio[src],audio source[src]").length > 0) return true;
  // A single hero/thumbnail image is not a complete article. Two or more
  // images can represent a genuine photo story/gallery without long text.
  if ($("img[src],picture source[src]").length >= 2) return true;
  return /\/(?:video|videos|audio)(?:\/|$)/i.test(new URL(article.url).pathname)
    && (Boolean(article.imageUrl) || $("img[src],picture source[src]").length > 0);
}

const persianMonths = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor((jy % 33 + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const leap = gy % 4 === 0 && gy % 100 !== 0 || gy % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1; while (gm <= 12 && gd > monthDays[gm - 1]) gd -= monthDays[gm++ - 1];
  return [gy, gm, gd];
}
export function normalizeTimestamp(value: string | null, now = new Date()): string | null {
  if (!value) return null;
  const normalized = value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).trim();
  if (/^\d{10,13}$/.test(normalized)) {
    const numeric = Number(normalized); const date = new Date(normalized.length === 10 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const relative = normalized.match(/(\d+)\s*(دقیقه|ساعت|روز)\s*(?:پیش|قبل)/);
  if (relative) {
    const unit = relative[2] === "دقیقه" ? 60_000 : relative[2] === "ساعت" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - Number(relative[1]) * unit).toISOString();
  }
  const month = persianMonths.findIndex(name => normalized.includes(name));
  const numbers = normalized.match(/\d+/g)?.map(Number) ?? [];
  if (month >= 0 && numbers.length >= 2) {
    const year = numbers.find(number => number >= 1200 && number <= 1700);
    const day = Number(normalized.match(new RegExp("(\\d{1,2})\\s*" + persianMonths[month]))?.[1]);
    if (year && day) {
      const time = normalized.match(/(\d{1,2}):(\d{2})/);
      const [gy, gm, gd] = jalaliToGregorian(year, month + 1, day);
      const local = new Date(gy, gm - 1, gd, Number(time?.[1] ?? 0), Number(time?.[2] ?? 0));
      return Number.isNaN(local.getTime()) ? null : local.toISOString();
    }
  }
  const numericDate = normalized.match(/\b(1[234]\d{2})[\/-](\d{1,2})[\/-](\d{1,2})(?:[^\d]+(\d{1,2}):(\d{2}))?/);
  if (numericDate) {
    const [gy, gm, gd] = jalaliToGregorian(Number(numericDate[1]), Number(numericDate[2]), Number(numericDate[3]));
    return new Date(gy, gm - 1, gd, Number(numericDate[4] ?? 0), Number(numericDate[5] ?? 0)).toISOString();
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface StructuredArticle {
  title: string | null; content: string | null; imageUrl: string | null; publishedAt: string | null;
  author: string | null; categories: string[]; tags: string[]; mediaHtml: string | null;
}
function structuredArticle(snapshot: Snapshot): StructuredArticle {
  const $ = cheerio.load(snapshot.html);
  const meta = (...selectors: string[]) => {
    for (const selector of selectors) {
      const value = $(selector).first().attr("content")?.trim();
      if (value) return value;
    }
    return null;
  };
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const type = primitiveValues(record["@type"]).map(String);
    if (type.some(item => /^(?:NewsArticle|Article|ReportageNewsArticle|VideoObject|AudioObject)$/i.test(item))) records.push(record);
    if (record["@graph"]) visit(record["@graph"]);
  };
  $("script[type='application/ld+json']").each((_, node) => { try { visit(JSON.parse($(node).text())); } catch { /* Invalid JSON-LD is ignored. */ } });
  const record = records[0] ?? {};
  const recordTypes = primitiveValues(record["@type"]).map(String);
  const mediaType = recordTypes.find(type => /^(?:VideoObject|AudioObject)$/i.test(type)) ?? null;
  const firstString = (value: unknown): string | null => {
    for (const item of primitiveValues(value)) {
      if (typeof item === "string" || typeof item === "number") return String(item).trim() || null;
      if (item && typeof item === "object") {
        const nested = item as Record<string, unknown>;
        const found = firstString(nested.url ?? nested.contentUrl ?? nested.name);
        if (found) return found;
      }
    }
    return null;
  };
  const split = (value: unknown) => [...new Set(primitiveValues(value).flatMap(item =>
    typeof item === "string" ? item.split(/[,،|]/).map(part => part.trim()).filter(Boolean) : [],
  ))];
  const rawAuthor = firstString(record.author) ?? meta("meta[name='author']");
  const author = rawAuthor && !/^https?:\/\//i.test(rawAuthor) ? rawAuthor : null;
  const image = firstString(record.image ?? record.thumbnailUrl ?? record.thumbnail) ?? meta("meta[property='og:image']", "meta[name='twitter:image']");
  const absoluteImage = absolute(image, snapshot.url);
  const mediaUrl = absolute(firstString(record.contentUrl), snapshot.url);
  const escapedAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/\"/g, "&quot;");
  const mediaHtml = mediaType === "VideoObject" && mediaUrl
    ? `<video controls${absoluteImage ? ` poster="${escapedAttribute(absoluteImage)}"` : ""}><source src="${escapedAttribute(mediaUrl)}"></video>`
    : mediaType === "AudioObject" && mediaUrl
      ? `<audio controls><source src="${escapedAttribute(mediaUrl)}"></audio>`
      : mediaType && absoluteImage ? `<img src="${escapedAttribute(absoluteImage)}">` : null;
  return {
    title: firstString(record.headline ?? record.name) ?? meta("meta[property='og:title']"),
    content: firstString(record.articleBody ?? (mediaType ? record.description : null)), imageUrl: absoluteImage,
    publishedAt: normalizeTimestamp(firstString(record.datePublished ?? record.uploadDate) ?? meta("meta[property='article:published_time']")),
    author, categories: split(record.articleSection ?? meta(
      "meta[property='article:section']",
      "meta[property='cXenseParse:recs:section']",
      "meta[name='page.subsection']",
      "meta[name='page.section']",
    )),
    tags: split(record.keywords ?? meta("meta[name='keywords']", "meta[property='article:tag']")), mediaHtml,
  };
}

export function extract(snapshot: Snapshot, plan: Plan, kind: Kind): Article[] {
  if (plan.mode === "unavailable") return [];
  const $ = cheerio.load(snapshot.html);
  const useHtml = plan.mode === "html" || plan.mode === "rendered";
  const sources = plan.mode === "embedded" || plan.mode === "browser-embedded" ? embeddedData(snapshot.html) : snapshot.apis;
  const roots: unknown[] = useHtml ? $(plan.root || "body").toArray() :
    sources.filter(s => !plan.responseUrlIncludes || s.url.includes(plan.responseUrlIncludes)).flatMap(s => jsonValues(s.data, plan.root));
  const items: Article[] = [];
  const structured = kind === "article" ? structuredArticle(snapshot) : null;
  for (const root of roots) {
    const readPath = (valuePath: string, attribute: string | null): unknown => {
      if (!useHtml) return jsonValues(root, valuePath);
      const context = $(root as Parameters<typeof $>[0]);
      const target = !valuePath || valuePath === "." || valuePath === "$" ? context : context.find(valuePath);
      return attribute ? target.first().attr(attribute) : target.toArray().map(el => {
        const node = $(el).clone(); node.find("script,style,noscript,nav,footer").remove();
        return node.html() ?? node.text();
      });
    };
    const field = (name: keyof Plan["fields"]) => {
      const spec = plan.fields[name];
      if (!spec) return null;
      if (spec.template) {
        let missing = false;
        const value = spec.template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
          if (key === "pageUrl") return snapshot.url;
          if (key === "origin") return new URL(snapshot.url).origin;
          const read = clean(readPath(key === "value" ? spec.path : key, spec.attribute));
          if (!read) missing = true;
          return read ? encodeURIComponent(read) : "";
        });
        return missing ? null : value;
      }
      return clean(readPath(spec.path, spec.attribute));
    };
    const fields = (name: keyof Plan["fields"]) => {
      const spec = plan.fields[name];
      return spec ? uniqueText(readPath(spec.path, spec.attribute)) : [];
    };
    const url = absolute(field("url"), snapshot.url) ?? (kind === "article" ? snapshot.url : null);
    const title = field("title") ?? structured?.title ?? null;
    if (!url || !title || title.length < 3) continue;
    if (kind === "listing" && plan.urlPattern) {
      let matches = false;
      try { matches = new RegExp(plan.urlPattern).test(new URL(url).pathname); } catch { throw new Error("الگوی URL خبر نامعتبر است."); }
      if (!matches) continue;
    }
    if (kind === "listing" && new URL(url).pathname === new URL(snapshot.url).pathname) continue;
    const contentSpec = plan.fields.content;
    const rawContent = contentSpec ? (!useHtml ? readPath(contentSpec.path, contentSpec.attribute) : (() => {
      const context = $(root as Parameters<typeof $>[0]);
      const target = !contentSpec.path || contentSpec.path === "." || contentSpec.path === "$" ? context : context.find(contentSpec.path);
      if (contentSpec.attribute) return target.toArray().map(element => $(element).attr(contentSpec.attribute!));
      return target.toArray().map(element => {
        const node = $(element).clone(); node.find("script,style,noscript,nav,footer").remove();
        return node.toString();
      });
    })()) : null;
    let content = clean(rawContent);
    let contentHtml = safeHtml(rawContent, snapshot.url);
    if (structured?.content && (!content || structured.content.length > content.length * 1.15)) {
      content = clean(structured.content); contentHtml = safeHtml(structured.content, snapshot.url);
    }
    if (structured?.mediaHtml && (!contentHtml || ((content?.length ?? 0) < 120 && !hasContentMedia(contentHtml)))) {
      const descriptionHtml = content ? safeHtml(content, snapshot.url) ?? "" : "";
      contentHtml = safeHtml(descriptionHtml + structured.mediaHtml, snapshot.url);
    }
    const plannedImage = absolute(field("imageUrl"), snapshot.url);
    let fallbackImage: string | null = null;
    let primaryImage: string | null = null;
    let semanticDate: string | null = null;
    let semanticAuthor: string | null = null;
    if (useHtml) {
      const context = $(root as Parameters<typeof $>[0]);
      const preferredImage = context.find("img[fetchpriority='high'],[itemprop='image'] img,figure img").first();
      primaryImage = absolute(preferredImage.attr("src") || preferredImage.attr("data-src") || preferredImage.attr("data-original") || null, snapshot.url);
      const image = context.find("img").first();
      fallbackImage = absolute(image.attr("src") || image.attr("data-src") || image.attr("data-original") || null, snapshot.url);
      if (!fallbackImage && kind === "article") fallbackImage = absolute($("meta[property='og:image'],meta[name='twitter:image']").first().attr("content") || null, snapshot.url);
      const dateNode = context.find("time[datetime],[itemprop='datePublished'],[class*='publish-date'],[class*='published-at']").first();
      semanticDate = normalizeTimestamp(dateNode.attr("datetime") || dateNode.attr("content") || clean(dateNode.text()));
      const authorNode = context.find("[itemprop='author'],[rel='author'],[class*='byline'],[class*='author'],[class*='reporter'],a[href*='/reporter/'],a[href*='/author/']").first();
      semanticAuthor = clean(authorNode.text()) || authorNode.attr("content") || null;
    }
    items.push({
      url, title, content, contentHtml,
      publishedAt: structured?.publishedAt ?? normalizeTimestamp(field("publishedAt")) ?? semanticDate, summary: field("summary"),
      imageUrl: structured?.imageUrl ?? primaryImage ?? plannedImage ?? fallbackImage,
      categories: [...new Set([...fields("categories"), ...(structured?.categories ?? [])])],
      tags: [...new Set([...fields("tags"), ...(structured?.tags ?? [])])], author: structured?.author ?? field("author") ?? semanticAuthor,
    });
  }
  const unique = new Map<string, Article>();
  for (const item of items) {
    const current = unique.get(item.url);
    // Selector unions can match overlapping article containers. Keep the
    // richest extraction rather than whichever root happened to appear last.
    const score = (candidate: Article) => (candidate.content?.length ?? 0)
      + (candidate.contentHtml?.length ?? 0) / 20
      + (hasStandaloneArticleMedia(candidate) ? 500 : 0);
    if (!current || score(item) > score(current)) unique.set(item.url, item);
  }
  return [...unique.values()];
}

export function validateArticleQuality(article: Article, snapshot: Snapshot, plan: Plan) {
  validateItems([article], "article");
  const $ = cheerio.load(snapshot.html);
  const root = plan.mode === "html" || plan.mode === "rendered" ? $(plan.root).first() : null;
  const rootText = root?.length ? clean(root.html()) : null;
  const contentLength = article.content?.length ?? 0;
  const hasMedia = hasStandaloneArticleMedia(article);
  const semanticRoot = Boolean(root?.is("article,main,[itemprop='articleBody']"));
  if (!hasMedia && semanticRoot && rootText && rootText.length >= 500 && contentLength < rootText.length * 0.35) {
    throw new Error(`متن خبر احتمالاً ناقص است: ${contentLength} نویسه از ${rootText.length} نویسهٔ بخش اصلی.`);
  }
  const html = cheerio.load(article.contentHtml!, null, false);
  const blockSelector = "p,li,h2,h3,blockquote";
  const selectedContent = root && plan.fields.content?.path ? root.find(plan.fields.content.path) : root;
  const sourceBlocks = selectedContent
    ? selectedContent.filter(blockSelector).filter((_, node) => $(node).text().trim().length >= 20).length
      + selectedContent.find(blockSelector).filter((_, node) => $(node).text().trim().length >= 20).length
    : 0;
  const extractedBlocks = html(blockSelector).filter((_, node) => html(node).text().trim().length >= 20).length;
  if (!hasMedia && sourceBlocks >= 3 && extractedBlocks < Math.ceil(sourceBlocks * 0.6)) {
    throw new Error(`ساختار HTML خبر ناقص است: ${extractedBlocks} بخش از ${sourceBlocks} بخش متنی.`);
  }
  const structured = structuredArticle(snapshot);
  if (structured.imageUrl && article.imageUrl !== structured.imageUrl) throw new Error("تصویر اصلی خبر با metadata صفحه تطابق ندارد.");
  if (structured.publishedAt && !article.publishedAt) throw new Error("تاریخ انتشار موجود در صفحه استخراج نشده است.");
  if (structured.author && !article.author) throw new Error("نویسندهٔ موجود در صفحه استخراج نشده است.");
  if (structured.categories.length && !article.categories.length) throw new Error("دسته‌بندی موجود در صفحه استخراج نشده است.");
  if (structured.tags.length && !article.tags.length) throw new Error("برچسب‌های موجود در صفحه استخراج نشده‌اند.");
  if (article.author && /^https?:\/\//i.test(article.author)) throw new Error("فیلد نویسنده به‌اشتباه URL است؛ نام نویسنده باید استخراج شود.");
  return article;
}

export function validateItems(items: Article[], kind: Kind): Article[] {
  if (!items.length) throw new Error("استخراج " + (kind === "listing" ? "فهرست خبر" : "خبر") + " خالی است.");
  if (kind === "article" && (!items[0].contentHtml || ((items[0].content?.length ?? 0) < 120 && !hasStandaloneArticleMedia(items[0])))) {
    throw new Error("متن کامل یا محتوای تصویری خبر استخراج نشده است.");
  }
  return items;
}

export function htmlHasEvidence(snapshot: Snapshot, kind: Kind) {
  if (embeddedData(snapshot.html).length) return true;
  const $ = cheerio.load(snapshot.html);
  $("nav,header,footer,script,style,noscript").remove();
  return kind === "listing" ? $("a[href]").toArray().filter(e => $(e).text().trim().length >= 8).length > 0 :
    $("article,main,[itemprop=articleBody]").text().trim().length >= 120 ||
      ($("h1").length > 0 && $("p").text().trim().length >= 120);
}

export function browserSnapshotLooksBlocked(snapshot: Snapshot) {
  if (snapshot.html.length >= 2_000) return false;
  return !htmlHasEvidence(snapshot, "listing") && !htmlHasEvidence(snapshot, "article");
}

export async function captureBrowser(
  value: string, signal: AbortSignal, waitMs = 15_000, observe: Observer = noop,
  until?: (snapshot: Snapshot) => boolean,
  headless = true,
): Promise<Snapshot> {
  await assertPublicUrl(value); signal.throwIfAborted();
  observe("browser", headless ? "مرورگر مستقل باز می‌شود؛ انتظار برای پاسخ APIها." : "سایت مرورگر headless را مسدود کرد؛ تلاش با Chrome عادی و محیط موقت انجام می‌شود.");
  const launchOptions = { ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) };
  const browser = headless ? await chromium.launch({ headless: true, ...launchOptions }) : null;
  const persistentContext = headless ? null : await chromium.launchPersistentContext(TEMP_BROWSER_PROFILE, {
    headless: false, ...launchOptions, serviceWorkers: "block", acceptDownloads: false, locale: "en-GB",
  });
  const closeBrowser = () => persistentContext ? persistentContext.close() : browser!.close();
  const abort = () => { void closeBrowser().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const pending = new Set<Promise<void>>();
  try {
    signal.throwIfAborted();
    const context = persistentContext ?? await browser!.newContext({ serviceWorkers: "block", acceptDownloads: false, locale: "en-GB" });
    // Fresh context: no user's cookies, profile, passwords or persisted credentials.
    await context.route("**/*", async route => {
      try {
        if (["image", "media", "font"].includes(route.request().resourceType())) return await route.abort();
        await assertPublicUrl(route.request().url());
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    const apis: ApiEvidence[] = [];
    let bytes = 0;
    let closing = false;
    const onResponse = (response: import("playwright").Response) => {
      const type = response.request().resourceType();
      if (closing || !["xhr", "fetch"].includes(type)) return;
      observe("api", "پاسخ درخواست دادهٔ صفحه", { endpoint: response.url().split("?")[0], httpStatus: response.status(), contentType: response.headers()["content-type"] });
      if (!response.ok() || apis.length >= 30) return;
      // Some public APIs send JSON with text/plain; inspect the body, not just MIME.
      if (Number(response.headers()["content-length"] ?? 0) > 2_000_000) return;
      const task = (async () => {
        try {
          const body = await response.body();
          if (closing || body.length > 2_000_000 || bytes + body.length > 8_000_000 || apis.length >= 30) return;
          // Do not retain headers or request bodies. Avoid auth/tracking responses.
          const endpoint = new URL(response.url());
          if (/login|auth|token|telemetry|analytics|tracking|\/user\//i.test(endpoint.pathname + endpoint.hostname)) return;
          let decoded: unknown;
          try { decoded = JSON.parse(body.toString("utf8")); }
          catch {
            try { decoded = decode(body, { useBigInt64: true }); }
            catch {
              observe("api", "فرمت پاسخ API قابل خواندن نیست؛ دادهٔ رندرشدهٔ صفحه بررسی خواهد شد.", { endpoint: endpoint.origin + endpoint.pathname });
              return;
            }
          }
          if (!decoded || typeof decoded !== "object") return;
          const data = JSON.parse(JSON.stringify(decoded, (_, value) => typeof value === "bigint" ? value.toString() : value));
          apis.push({ url: endpoint.origin + endpoint.pathname, data });
          bytes += body.length;
          observe("api", "پاسخ JSON عمومی دریافت شد.", { endpoint: endpoint.origin + endpoint.pathname, characters: body.length, responses: apis.length });
        } catch { /* Non-JSON bodies are not API evidence. */ }
      })();
      pending.add(task); void task.finally(() => pending.delete(task));
    };
    page.on("response", onResponse);
    page.on("requestfailed", request => {
      if (["document", "xhr", "fetch"].includes(request.resourceType())) observe("browser", "یک درخواست صفحه ناموفق بود.", { resource: request.resourceType(), endpoint: request.url().split("?")[0] });
    });
    const response = await page.goto(value, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (response && !response.ok()) {
      if (headless && [401, 403].includes(response.status())) {
        closing = true;
        page.off("response", onResponse);
        await closeBrowser();
        return await captureBrowser(value, signal, waitMs, observe, until, false);
      }
      throw new Error("مرورگر پاسخ HTTP " + response.status() + " دریافت کرد.");
    }
    const deadline = Date.now() + waitMs;
    let snapshot: Snapshot = { url: page.url(), html: "", apis };
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        snapshot = { url: page.url(), html: (await page.content()).slice(0, MAX_HTML), apis: [...apis] };
        if (until?.(snapshot)) break;
      } catch (error) {
        observe("browser", "صفحه هنگام خواندن در حال تغییر مسیر بود؛ پس از پایدارشدن دوباره بررسی می‌شود.", { reason: error instanceof Error ? error.message : String(error) });
      }
      await page.waitForTimeout(250);
    }
    // Response bodies still downloading are bounded by context closure below.
    try { snapshot = { url: page.url(), html: (await page.content()).slice(0, MAX_HTML), apis: [...apis] }; }
    catch { /* Keep the most recent stable DOM captured in the loop. */ }
    if (!snapshot.html) throw new Error("صفحهٔ مرورگر پیش از ثبت DOM پایدار چند بار تغییر مسیر داد.");
    if (browserSnapshotLooksBlocked(snapshot)) throw new Error("مرورگر به‌جای محتوای سایت یک صفحهٔ خالی یا challenge ضدبات دریافت کرد؛ اجرا باید دوباره تلاش شود.");
    closing = true;
    page.off("response", onResponse);
    observe("browser", "بررسی صفحهٔ رندرشده پایان یافت.", { apiResponses: apis.length, htmlCharacters: snapshot.html.length });
    return snapshot;
  } finally {
    signal.removeEventListener("abort", abort);
    await closeBrowser().catch(() => {});
    await Promise.allSettled([...pending]);
  }
}

export class RecipeCrawler {
  constructor(
    readonly recipe: Recipe,
    private observe: Observer = noop,
    private io: { html: typeof fetchSnapshot; browser: typeof captureBrowser } = { html: fetchSnapshot, browser: captureBrowser },
  ) {}
  private async execute(url: string, plan: Plan, kind: Kind, signal: AbortSignal) {
    const validate = (snapshot: Snapshot) => {
      const items = validateItems(extract(snapshot, plan, kind), kind);
      if (kind === "article") validateArticleQuality(items[0], snapshot, plan);
      return items;
    };
    if (plan.mode === "html" || plan.mode === "embedded") {
      try {
        const html = await this.io.html(url, signal, this.observe);
        return validate(html);
      }
      catch (error) {
        signal.throwIfAborted();
        this.observe("fallback", "استخراج HTML کافی نبود؛ همان قواعد روی صفحهٔ رندرشده آزمایش می‌شوند.", { reason: error instanceof Error ? error.message : String(error) });
        const browser = await this.io.browser(url, signal, this.recipe.browserWaitMs, this.observe, snapshot => { try { validate(snapshot); return true; } catch { return false; } });
        return validate(browser);
      }
    }
    const snapshot = await this.io.browser(url, signal, this.recipe.browserWaitMs, this.observe, candidate => { try { validate(candidate); return true; } catch { return false; } });
    return validate(snapshot);
  }
  crawlListing(url = this.recipe.listingUrl, signal = AbortSignal.timeout(90_000)) {
    return this.execute(url, this.recipe.listing, "listing", signal);
  }
  async crawlArticle(url: string, signal = AbortSignal.timeout(90_000)) {
    return (await this.execute(url, this.recipe.article, "article", signal))[0];
  }
}
