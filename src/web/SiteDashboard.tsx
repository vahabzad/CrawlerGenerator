import { FormEvent, useEffect, useRef, useState } from "react";
import type { Article } from "../crawler/recipe";
import type { LogEntry, SiteArticleCollection, SiteArticlePreview, SiteDetails, SiteSummary } from "../shared/logs";
import { LogPanel } from "./LogPanel";
import { readSiteActionStream } from "./site-action-stream";

type ChatItem = { role: "user" | "assistant"; content: string };
const emptyArticles: SiteArticleCollection = { outputFile: null, status: "empty", discovered: 0, failed: 0, articles: [] };
function formatDate(value: string | null) {
  if (!value) return "تاریخ نامشخص";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("fa-IR", { dateStyle: "long", timeStyle: "short" });
}

export function SiteDashboard() {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [selected, setSelected] = useState<SiteDetails | null>(null);
  const [articles, setArticles] = useState<SiteArticleCollection>(emptyArticles);
  const [articleLoading, setArticleLoading] = useState(false);
  const [opened, setOpened] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState("");
  const [chat, setChat] = useState<Record<string, ChatItem[]>>({});
  const [draft, setDraft] = useState("");
  const pending = useRef<AbortController | null>(null);

  async function loadArticles(id: string) {
    setArticleLoading(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(id)}/articles`);
      if (!response.ok) throw new Error("دریافت خبرها ناموفق بود.");
      setArticles(await response.json() as SiteArticleCollection);
    } finally { setArticleLoading(false); }
  }
  async function refresh(preferredId?: string) {
    const response = await fetch("/api/sites");
    if (!response.ok) throw new Error("دریافت فهرست سایت‌ها ناموفق بود.");
    const data = await response.json() as { sites: SiteSummary[] };
    setSites(data.sites);
    const id = preferredId ?? selected?.id ?? data.sites[0]?.id;
    if (id) {
      const details = await fetch("/api/sites/" + encodeURIComponent(id));
      if (!details.ok) throw new Error("دریافت اطلاعات سایت ناموفق بود.");
      setSelected(await details.json() as SiteDetails);
      await loadArticles(id);
    } else { setSelected(null); setArticles(emptyArticles); }
  }
  useEffect(() => {
    refresh().catch(error => setNotice(error instanceof Error ? error.message : "خطا در بارگذاری")).finally(() => setLoading(false));
    return () => pending.current?.abort();
  }, []);
  useEffect(() => {
    if (!opened) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpened(null); };
    window.addEventListener("keydown", close); document.body.classList.add("modal-open");
    return () => { window.removeEventListener("keydown", close); document.body.classList.remove("modal-open"); };
  }, [opened]);
  async function choose(id: string) {
    if (busy) return;
    setNotice(""); setOpened(null); setArticles(emptyArticles);
    try { await refresh(id); } catch (error) { setNotice(error instanceof Error ? error.message : "خطا در بارگذاری"); }
  }
  async function runFull() {
    if (!selected || busy) return;
    const id = selected.id, controller = new AbortController(); pending.current = controller;
    setBusy(true); setLogs([]); setNotice("اجرای کامل کرالر آغاز شد؛ همهٔ خبرهای فهرست پردازش می‌شوند…");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(id)}/run`, { method: "POST", headers: { accept: "application/x-ndjson" }, signal: controller.signal });
      await readSiteActionStream(response, event => {
        if (event.type === "log") { setLogs(old => [...old, event.entry]); setNotice(event.entry.message); }
        else if (event.type === "run_result") setNotice(`اجرا تمام شد: ${event.extracted.toLocaleString("fa-IR")} خبر استخراج شد و ${event.failed.toLocaleString("fa-IR")} خبر خطا داشت.`);
        else if (event.type === "failure") setNotice("اجرای کامل ناموفق بود: " + event.message);
      });
      await refresh(id);
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "اجرای کامل ناموفق بود."); }
    finally { setBusy(false); pending.current = null; }
  }
  async function openArticle(article: SiteArticlePreview) {
    if (!selected || !articles.outputFile) return;
    setArticleLoading(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(selected.id)}/articles/${encodeURIComponent(articles.outputFile)}/${article.index}`);
      if (!response.ok) throw new Error("دریافت جزئیات خبر ناموفق بود.");
      setOpened(await response.json() as Article);
    } catch (error) { setNotice(error instanceof Error ? error.message : "دریافت جزئیات خبر ناموفق بود."); }
    finally { setArticleLoading(false); }
  }
  async function sendChat(event: FormEvent, applyFix = false) {
    event.preventDefault();
    if (!selected || !draft.trim() || busy) return;
    const text = draft.trim(), id = selected.id, history = chat[id] ?? [];
    setChat(value => ({ ...value, [id]: [...history, { role: "user", content: text }] }));
    setDraft(""); setLogs([]); setBusy(true);
    setNotice(applyFix ? "Codex در حال بازسازی و آزمایش قواعد است…" : "Codex در حال بررسی فایل‌های این سایت است…");
    const controller = new AbortController(); pending.current = controller;
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(id)}/chat`, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ message: text, applyFix, history }), signal: controller.signal });
      await readSiteActionStream(response, action => {
        if (action.type === "log") { setLogs(old => [...old, action.entry]); setNotice(action.entry.message); }
        else if (action.type === "chat_result") {
          setChat(value => ({ ...value, [id]: [...(value[id] ?? []), { role: "assistant", content: action.message }] }));
          setNotice(action.message); if (action.site) void refresh(id);
        } else if (action.type === "failure") {
          const failure = "عملیات ناموفق بود: " + action.message;
          setChat(value => ({ ...value, [id]: [...(value[id] ?? []), { role: "assistant", content: failure }] })); setNotice(failure);
        }
      });
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "گفتگو ناموفق بود."); }
    finally { setBusy(false); pending.current = null; }
  }
  if (loading) return <section className="card">در حال خواندن کرالرهای ساخته‌شده…</section>;
  return <section className="dashboard">
    <aside className="site-list card">
      <div className="section-title"><h2>سایت‌ها</h2><button className="secondary" type="button" onClick={() => void refresh()}>تازه‌سازی</button></div>
      {!sites.length && <p className="hint">هنوز کرالر آزمایش‌شده‌ای ساخته نشده است.</p>}
      {sites.map(site => <button type="button" key={site.id} className={`site-row ${selected?.id === site.id ? "active" : ""}`} onClick={() => void choose(site.id)}><strong>{site.id}</strong><span>{site.listingCount.toLocaleString("fa-IR")} لینک پیدا شده · {site.listingMode}</span></button>)}
    </aside>
    <div className="site-content">{selected ? <>
      <section className="card site-overview">
        <div className="section-title"><div><p className="eyebrow">{selected.id}</p><h2>کرالر فعال</h2></div><span className="status-pill">آمادهٔ اجرا</span></div>
        <a className="site-url" href={selected.listingUrl} target="_blank" rel="noreferrer">{selected.listingUrl}</a>
        <div className="stats"><div><strong>{selected.listingCount.toLocaleString("fa-IR")}</strong><span>لینک پیدا شده</span></div><div><strong>{articles.articles.length.toLocaleString("fa-IR")}</strong><span>خبر استخراج‌شده</span></div><div><strong>{articles.failed.toLocaleString("fa-IR")}</strong><span>خبر خطادار</span></div></div>
        <p className="hint">نسخه: <code dir="ltr">{selected.version}</code> · فهرست: {selected.listingMode} · خبر: {selected.articleMode}</p>
        <div className="actions"><button disabled={busy} type="button" onClick={() => void runFull()}>{busy ? "در حال اجرا…" : "اجرای کامل کرالر"}</button>{busy && <button type="button" className="danger" onClick={() => pending.current?.abort()}>لغو اجرا</button>}</div>
      </section>
      {notice && <div className="result" aria-live="polite">{notice}</div>}
      {logs.length > 0 && <LogPanel logs={logs} busy={busy} />}
      <section className="card news-section">
        <div className="section-title"><div><h2>اخبار استخراج‌شده</h2><p className="hint">برای دیدن متن کامل و مشخصات، روی هر خبر بزنید.</p></div><span className="status-pill">{articles.articles.length.toLocaleString("fa-IR")} خبر</span></div>
        {articleLoading && !articles.articles.length ? <p className="hint">در حال بارگذاری خبرها…</p> : !articles.articles.length ? <div className="empty-news"><p>هنوز اجرای کاملی برای این سایت وجود ندارد.</p><button disabled={busy} onClick={() => void runFull()}>اجرای کامل کرالر</button></div> : <div className="news-grid">{articles.articles.map(article => <button className="news-card" type="button" key={article.index + article.url} onClick={() => void openArticle(article)}>
          <div className="news-image">{article.imageUrl ? <img src={article.imageUrl} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = "none"; }} /> : <span>بدون تصویر</span>}</div>
          <div className="news-card-body"><h3>{article.title}</h3>{article.summary && <p>{article.summary}</p>}<div className="news-meta"><span>{article.author || "نویسنده نامشخص"}</span><time>{formatDate(article.publishedAt)}</time></div>{article.categories.length > 0 && <div className="chips">{article.categories.slice(0, 3).map(value => <span key={value}>{value}</span>)}</div>}</div>
        </button>)}</div>}
      </section>
      <section className="card chat-card">
        <div className="section-title"><div><h2>گفتگو با Codex</h2><p className="hint">Codex فقط فایل‌های همین سایت را بررسی می‌کند.</p></div></div>
        <div className="chat-thread">{!(chat[selected.id]?.length) && <p className="chat-empty">مثلاً بپرسید: «چرا بعضی خبرها نویسنده ندارند؟» یا «الگوی URL همهٔ خبرها را می‌گیرد؟»</p>}{chat[selected.id]?.map((item, index) => <div key={index} className={`bubble ${item.role}`}>{item.content}</div>)}</div>
        <form onSubmit={event => void sendChat(event)}><textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="مشکل یا سؤال دربارهٔ کرالر این سایت…" rows={4} maxLength={4000} /><div className="actions"><button disabled={busy || !draft.trim()}>فقط بررسی و پاسخ</button><button disabled={busy || !draft.trim()} type="button" className="repair" onClick={event => void sendChat(event as unknown as FormEvent, true)}>اصلاح کرالر و آزمایش</button></div></form>
      </section>
    </> : <section className="card">یک سایت را انتخاب کنید.</section>}</div>
    {opened && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpened(null); }}><article className="article-modal" role="dialog" aria-modal="true" aria-labelledby="article-title">
      <button className="modal-close" type="button" aria-label="بستن" onClick={() => setOpened(null)}>×</button>
      {opened.imageUrl && <img className="article-cover" src={opened.imageUrl} alt={opened.title} />}
      <div className="article-modal-body"><div className="chips">{opened.categories.map(value => <span key={value}>{value}</span>)}</div><h2 id="article-title">{opened.title}</h2>
        <div className="article-byline"><span>نویسنده: {opened.author || "نامشخص"}</span><time>تاریخ انتشار: {formatDate(opened.publishedAt)}</time></div>
        {opened.summary && <p className="article-summary">{opened.summary}</p>}
        {opened.contentHtml ? <div className="article-html" dangerouslySetInnerHTML={{ __html: opened.contentHtml }} /> : <div className="article-html"><p>{opened.content}</p></div>}
        {opened.tags.length > 0 && <div className="tag-block"><strong>برچسب‌ها</strong><div className="chips">{opened.tags.map(value => <span key={value}>{value}</span>)}</div></div>}
        <a className="source-link" href={opened.url} target="_blank" rel="noreferrer">مشاهدهٔ خبر در سایت اصلی</a>
      </div>
    </article></div>}
  </section>;
}
