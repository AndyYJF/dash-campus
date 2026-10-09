import crypto from "node:crypto";
import { canonicalUrl, locateQuote } from "./exploration";
import {
  newsDigestSchema,
  type NewsDigest,
  type NewsSource,
} from "@/contracts/ai-news";
export function newsUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    if (
      h === "localhost" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      !h.includes(".") ||
      h.includes(":") ||
      /^\d+(\.\d+){3}$/.test(h)
    )
      return null;
    return canonicalUrl(u.href);
  } catch {
    return null;
  }
}
export function prepareNews(
  sources: NewsSource[],
  now: Date,
  days: number,
): { sources: NewsSource[]; unknownDates: number } {
  const cutoff = now.getTime() - days * 86400_000,
    seen = new Set<string>();
  let unknownDates = 0;
  const filtered = sources.flatMap((s) => {
    const url = newsUrl(s.url);
    if (!url || !s.title.trim() || !s.text.trim()) return [];
    const t = s.publishedAt ? Date.parse(s.publishedAt) : NaN;
    if (!Number.isFinite(t)) {
      unknownDates++;
      return [];
    }
    if (t < cutoff || t > now.getTime()) return [];
    if (seen.has(url)) return [];
    seen.add(url);
    return [
      {
        ...s,
        id: crypto.createHash("sha256").update(url).digest("hex").slice(0, 24),
        url,
        publishedAt: new Date(t).toISOString(),
        title: s.title.slice(0, 300),
        text: s.text.slice(0, 3000),
      },
    ];
  });
  const counts = new Map<string, number>();
  return {
    sources: filtered
      .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))
      .filter((s) => {
        const n = counts.get(s.publisher) ?? 0;
        counts.set(s.publisher, n + 1);
        return n < 12;
      })
      .slice(0, 48),
    unknownDates,
  };
}
export function validateNewsDigest(
  raw: unknown,
  sources: NewsSource[],
): NewsDigest {
  const d = newsDigestSchema.parse(raw),
    seen = new Set<string>();
  if (sources.length && !d.stories.length)
    throw new Error("有可用资料但模型未产生盘点");
  for (const story of d.stories) {
    for (const c of story.citations) {
      const s = sources.find((x) => x.id === c.sourceId);
      if (!s || locateQuote(s.text, c.quote) < 0)
        throw new Error("资讯引用无法在本次来源中核对");
    }
    const key = story.citations
      .map((c) => c.sourceId)
      .sort()
      .join(":");
    if (seen.has(key)) throw new Error("同一来源被重复写成多条新闻");
    seen.add(key);
  }
  return d;
}
