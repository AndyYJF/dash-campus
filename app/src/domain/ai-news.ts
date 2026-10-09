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
/** 来源约束同时交给 provider 的一次有界修复；最终保存前再用同一约束复核。 */
export function newsDigestForSources(sources: NewsSource[]) {
  return newsDigestSchema.superRefine((d, ctx) => {
    if (sources.length && !d.stories.length)
      ctx.addIssue({ code: "custom", path: ["stories"], message: "有可用资料但模型未产生盘点" });
    const seen = new Set<string>();
    d.stories.forEach((story, i) => {
      story.citations.forEach((c, j) => {
        const source = sources.find((s) => s.id === c.sourceId);
        if (!source || locateQuote(source.text, c.quote) < 0)
          ctx.addIssue({ code: "custom", path: ["stories", i, "citations", j],
            message: source
              ? `资讯引用无法核对；quote必须是text的连续原文，不翻译、不加省略号。可直接使用此原文片段：${JSON.stringify(source.text.slice(0, 120).trim())}`
              : "资讯引用sourceId不在本次sources中，请复制给定来源的id" });
      });
      const key = story.citations.map((c) => c.sourceId).sort().join(":");
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: ["stories", i, "citations"], message: "同一来源被重复写成多条新闻，请合并" });
      seen.add(key);
    });
  });
}
export function validateNewsDigest(raw: unknown, sources: NewsSource[]): NewsDigest {
  return newsDigestForSources(sources).parse(raw);
}
