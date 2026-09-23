import { FormEvent, useState, useRef, useEffect } from "react";
import type { GenerationEvent, LogEntry } from "../shared/logs";
import { readGenerationStream } from "./generation-stream";
import { LogPanel, stageLabels } from "./LogPanel";
import { SiteDashboard } from "./SiteDashboard";
const sampleListing = "https://farsnews.ir/social/showcase";
export function App() {
  const [view, setView] = useState<"sites" | "generate">("sites");
  const [listingUrl, setListingUrl] = useState(sampleListing);
  const [articleUrl, setArticleUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<Extract<GenerationEvent, {type: "result"}> | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setStatus("loading"); setMessage("در حال اتصال به سرور…"); setSource(""); setResult(null); setLogs([]);
    try {
      const response = await fetch("/api/generate", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ listingUrl, articleUrl }), signal: controller.signal,
      });
      await readGenerationStream(response, data => {
        if (data.type === "log") {
          setLogs(previous => [...previous, data.entry]);
          setMessage(data.entry.message);
        } else if (data.type === "result") {
          setResult(data); setSource(data.source); setMessage("کرالر آماده شد. فایل در " + data.file + " ذخیره شده است."); setStatus("done");
        } else {
          setMessage("خطا در " + (stageLabels[data.stage] ?? data.stage) + ": " + data.message + " | شناسهٔ اجرا: " + data.requestId); setStatus("error");
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "خطایی رخ داد."); setStatus("error");
      }
    } finally { pending.current = null; }
  }
  return <main><section className="hero"><p className="eyebrow">CRAWLER CONTROL CENTER</p><h1>{view === "sites" ? "مدیریت و پایش کرالرهای خبری" : "برای هر سایت خبری، کرالر مستقل بسازید."}</h1><p>{view === "sites" ? "سایت‌ها را ببینید، تست واقعی اجرا کنید، خروجی‌ها را بررسی کنید و مشکل هر کرالر را با Codex برطرف کنید." : "لینک فهرست را بدهید؛ HTML و APIها بررسی می‌شوند و کرالر پس از آزمایش واقعی آماده خواهد شد."}</p></section><nav className="tabs"><button className={view === "sites" ? "active" : ""} onClick={() => setView("sites")}>سایت‌های ساخته‌شده</button><button className={view === "generate" ? "active" : ""} onClick={() => setView("generate")}>ساخت کرالر جدید</button></nav>{view === "sites" ? <SiteDashboard /> : <><form onSubmit={generate} className="card"><label>آدرس صفحهٔ فهرست خبر<input required type="url" value={listingUrl} onChange={e => setListingUrl(e.target.value)} placeholder="https://example.com/news" /></label><label>آدرس خبر نمونه (اختیاری)<input type="url" value={articleUrl} onChange={e => setArticleUrl(e.target.value)} placeholder="https://example.com/news/example" /></label><p className="hint">اگر خبر نمونه وارد نکنید، سیستم خودش یک خبر از فهرست انتخاب می‌کند.</p><button disabled={status === "loading"}>{status === "loading" ? "در حال تولید…" : "ساخت کرالر"}</button></form>{message && <section className={`result ${status}`} aria-live="polite">{message}</section>}{logs.length > 0 && <LogPanel logs={logs} busy={status === "loading"} />}{result?.sample && <section className="card"><h2>نتیجهٔ آزمایش واقعی</h2><p>تعداد خبرهای فهرست: {result.sample.listingCount}</p><p>روش فهرست: {result.strategies?.listing} · روش متن خبر: {result.strategies?.article}</p><h3>{result.sample.article.title}</h3><p className="article-preview">{result.sample.article.content?.slice(0, 1600)}</p><p className="hint">اجرای مستقل از پوشهٔ پروژه:</p><pre dir="ltr">npm run run:generated</pre></section>}{source && <details open><summary>مشاهدهٔ کد تولیدشده</summary><pre><code>{source}</code></pre></details>}</>}<footer>فقط سایت‌هایی را کرال کنید که مجوز آن را دارید و قوانین سایت را رعایت کنید.</footer></main>;
}
