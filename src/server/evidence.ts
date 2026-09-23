import * as cheerio from "cheerio";
import type { Snapshot } from "../crawler/recipe";
import { embeddedData } from "../crawler/runtime";

// Bounded structural samples: arrays retain their shape; no headers/cookies/secrets.
export function sampleJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 6000);
  if (Array.isArray(value)) return value.slice(0, 4).map(v => sampleJson(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([key]) => !/password|secret|token|cookie|authorization/i.test(key))
      .slice(0, 80).map(([key, child]) => [key, sampleJson(child, depth + 1)]),
  );
  return value;
}
export function evidence(snapshot: Snapshot) {
  const $ = cheerio.load(snapshot.html);
  $("script,style,noscript,svg,nav,footer").remove();
  return JSON.stringify({
    pageUrl: snapshot.url,
    html: $.html().slice(0, 100_000),
    embedded: embeddedData(snapshot.html).slice(0, 8).map(api => ({ source: api.url, sample: sampleJson(api.data) })),
    apis: snapshot.apis.map(api => ({ url: api.url, sample: sampleJson(api.data) }))
      .filter(api => JSON.stringify(api.sample).length > 50).slice(0, 24),
  }).slice(0, 320_000);
}
