import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getSite, getSiteArticle, listSiteArticles, listSites, readSiteOutput } from "../src/server/site-manager";

const field = (name: string) => ({ path: name, attribute: null, template: null });
const plan = { mode: "html", root: ".news", responseUrlIncludes: null, urlPattern: "^/news/\\d+$", fields: { url: field("a"), title: field("h2"), publishedAt: null, summary: null, content: null, imageUrl: null, categories: null, tags: null, author: null }, explanation: "test" };

test("site manager follows the published wrapper and rejects output traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crawler-sites-"));
  try {
    const site = path.join(root, "generated", "sites", "example-com");
    const active = "2026-09-01T01-02-03-004Z";
    const candidate = "2026-09-01T02-02-03-004Z";
    for (const version of [active, candidate]) {
      const directory = path.join(site, "versions", version);
      await mkdir(path.join(directory, "outputs"), { recursive: true });
      await writeFile(path.join(directory, "recipe.json"), JSON.stringify({ listingUrl: "https://example.com/news", listing: plan, article: { ...plan, urlPattern: null }, browserWaitMs: 1000 }));
      await writeFile(path.join(directory, "sample.json"), JSON.stringify({ listingCount: version === active ? 15 : 99, articles: [{ url: "https://example.com/news/1" }] }));
    }
    await writeFile(path.join(site, "crawler.ts"), `export * from "./versions/${active}/crawler";`);
    const output = "2026-09-01T03-00-00-000Z-12345678-1234-1234-1234-123456789abc.json";
    const article = { url: "https://example.com/news/1", title: "خبر آزمایشی", publishedAt: "2026-09-01T03:00:00.000Z", summary: "خلاصه", content: "متن کامل خبر", contentHtml: "<p>متن کامل خبر</p>", imageUrl: "https://example.com/image.jpg", categories: ["اجتماعی"], tags: ["آزمایش"], author: "خبرنگار" };
    await writeFile(path.join(site, "versions", active, "outputs", output), JSON.stringify({ crawledAt: "2026-09-01T03:00:00.000Z", status: "completed", mode: "all", discovered: 12, items: [article], errors: [] }));
    const sites = await listSites(root);
    assert.equal(sites.length, 1);
    // Counts shown beside extracted/failed totals must come from the same full
    // run, not the older generation-time sample.
    assert.equal(sites[0].listingCount, 12);
    const details = await getSite(root, "example-com");
    assert.equal(details.version, active);
    assert.equal(details.outputs[0].extracted, 1);
    assert.equal((await readSiteOutput(root, "example-com", output) as { discovered: number }).discovered, 12);
    const news = await listSiteArticles(root, "example-com");
    assert.equal(news.articles[0].title, "خبر آزمایشی");
    assert.equal((await getSiteArticle(root, "example-com", output, 0)).contentHtml, "<p>متن کامل خبر</p>");
    await assert.rejects(() => readSiteOutput(root, "example-com", "../recipe.json"), /معتبر نیست/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
