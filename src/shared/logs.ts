export type LogLevel = "info" | "warn" | "error";
export type LogStatus = "started" | "completed" | "failed" | "progress";
export interface LogEntry {
  requestId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  stage: string;
  level: LogLevel;
  status: LogStatus;
  message: string;
  details?: Record<string, unknown>;
}
export type GenerationEvent =
  | { type: "log"; entry: LogEntry }
  | { type: "result"; requestId: string; file: string; source: string; sample?: { listingCount: number; article: { url: string; title: string; content: string | null } }; strategies?: { listing: string; article: string } }
  | { type: "failure"; requestId: string; stage: string; message: string };

export interface SiteSummary {
  id: string; listingUrl: string; version: string; updatedAt: string;
  listingMode: string; articleMode: string; articlePattern: string | null;
  verifiedArticles: number; listingCount: number; outputCount: number;
}
export interface SiteOutputSummary {
  file: string; createdAt: string; status: string; mode: string;
  discovered: number; extracted: number; failed: number;
}
export interface SiteDetails extends SiteSummary {
  sampleArticleUrl: string | null; outputs: SiteOutputSummary[];
}
export interface SiteArticlePreview {
  index: number; url: string; title: string; imageUrl: string | null;
  publishedAt: string | null; author: string | null; summary: string | null;
  categories: string[]; tags: string[];
}
export interface SiteArticleCollection {
  outputFile: string | null; status: string; discovered: number; failed: number;
  articles: SiteArticlePreview[];
}
export type SiteActionEvent =
  | { type: "log"; entry: LogEntry }
  | { type: "test_result"; requestId: string; listingCount: number; verifiedArticles: number; outputFile: string }
  | { type: "run_result"; requestId: string; discovered: number; extracted: number; failed: number; status: string }
  | { type: "chat_result"; requestId: string; message: string; site?: SiteSummary }
  | { type: "failure"; requestId: string; stage: string; message: string };
