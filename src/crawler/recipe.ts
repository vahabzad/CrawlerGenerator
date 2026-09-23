import { z } from "zod";

const field = z.object({
  path: z.string().max(500),
  attribute: z.string().max(80).nullable(),
  template: z.string().max(1000).nullable(),
}).strict();
export const planSchema = z.object({
  mode: z.enum(["html", "embedded", "api", "rendered", "browser-embedded", "unavailable"]),
  // CSS selector for html/rendered; dot JSON path with * array wildcard otherwise.
  root: z.string().max(500),
  responseUrlIncludes: z.string().max(500).nullable(),
  // Optional pathname regex used to retain article links and exclude navigation/profile links.
  urlPattern: z.string().max(1000).nullable(),
  fields: z.object({
    url: field.nullable(), title: field.nullable(), publishedAt: field.nullable(),
    summary: field.nullable(), content: field.nullable(), imageUrl: field.nullable(),
    categories: field.nullable(), tags: field.nullable(), author: field.nullable(),
  }).strict(),
  explanation: z.string().max(1500),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export interface Recipe { listingUrl: string; listing: Plan; article: Plan; browserWaitMs: number; }
export interface ApiEvidence { url: string; data: unknown; }
export interface Snapshot { url: string; html: string; apis: ApiEvidence[]; }
export interface Article {
  url: string; title: string; publishedAt: string | null; summary: string | null;
  content: string | null; contentHtml: string | null; imageUrl: string | null;
  categories: string[]; tags: string[]; author: string | null;
}
export type Kind = "listing" | "article";
export type Observer = (stage: string, message: string, details?: Record<string, unknown>) => void;
