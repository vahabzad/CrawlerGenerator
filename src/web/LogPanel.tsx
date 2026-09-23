import { useEffect, useState } from "react";
import type { LogEntry } from "../shared/logs";

export const stageLabels: Record<string, string> = {
  request: "درخواست", "request.parse": "خواندن درخواست", validation: "بررسی ورودی",
  configuration: "تنظیمات", "listing.fetch": "صفحهٔ فهرست",
  "article.fetch": "خبر نمونه", codex: "Codex",
  "output.validate": "استخراج کد", "output.save": "ذخیرهٔ فایل", logging: "ذخیرهٔ لاگ",
  "listing.html": "HTML فهرست", "listing.browser": "مرورگر فهرست", "listing.api": "API فهرست",
  "listing.design": "ساخت استخراج فهرست", "listing.fallback": "مسیر جایگزین فهرست",
  "article.select": "انتخاب خبر نمونه", "article.html": "HTML خبر", "article.browser": "مرورگر خبر",
  "article.api": "API خبر", "article.design": "ساخت استخراج متن خبر", "article.fallback": "مسیر جایگزین خبر",
  "output.prepare": "ساخت بستهٔ مستقل", "verify.live": "آزمایش زندهٔ کرالر",
  "site.test": "آزمایش سایت", "site.runner": "اجرای کرالر", "site.chat": "گفتگو با Codex", "site.repair": "اصلاح کرالر",
  "site.run": "اجرای کامل",
};
export function LogPanel({ logs, busy }: { logs: LogEntry[]; busy: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const active = new Set<string>();
  for (const log of logs) {
    if (log.status === "started") active.add(log.stage);
    if (log.status === "completed" || log.status === "failed") active.delete(log.stage);
  }
  active.delete("request");
  const last = logs.at(-1);
  function download() {
    const url = URL.createObjectURL(new Blob([logs.map(log => JSON.stringify(log)).join("\n") + "\n"], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = (logs[0]?.requestId ?? "run") + ".jsonl"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="log-panel">
    <div className="log-heading"><h2>گزارش زندهٔ اجرا</h2><button type="button" className="secondary" onClick={download}>دریافت لاگ</button></div>
    <p className="log-current" aria-live="polite">
      {busy ? "در حال اجرا: " + ([...active].map(stage => stageLabels[stage] ?? stage).join(" و ") || "آماده‌سازی") : "اجرا پایان یافته است"}
    </p>
    {last && <p className="log-meta">شناسهٔ اجرا: <code dir="ltr">{last.requestId}</code><br />
      زمان سپری‌شده: {Math.round((busy ? Math.max(0, now - Date.parse(logs[0].timestamp)) : last.elapsedMs) / 1000)} ثانیه
      {busy && " · آخرین گزارش: " + Math.max(0, Math.floor((now - Date.parse(last.timestamp)) / 1000)) + " ثانیه پیش"}
    </p>}
    <ol className="log-list">
      {logs.slice(-500).map(entry => <li key={entry.sequence} className={"log-entry log-" + entry.level + " log-" + entry.status}>
        <div className="log-line"><time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString("fa-IR")}</time><span>{stageLabels[entry.stage] ?? entry.stage}</span><span className="log-badge">{entry.status === "failed" ? "خطا" : entry.status === "completed" ? "انجام شد" : entry.status === "started" ? "شروع" : entry.level === "warn" ? "هشدار" : "وضعیت"}</span></div>
        <p>{entry.message}</p>
        {entry.details && <details><summary>جزئیات</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>}
      </li>)}
    </ol>
    {logs.length > 500 && <p className="hint">۵۰۰ رویداد آخر نمایش داده می‌شود؛ فایل دانلودی شامل همهٔ رویدادهای این صفحه است.</p>}
  </section>;
}
