import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { NewsSource } from "@/contracts/ai-news";
export const NEWS_FEEDS = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  {
    name: "Google AI",
    url: "https://blog.google/innovation-and-ai/technology/ai/rss/",
  },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI" },
] as const;
const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number"
      ? String(v)
      : v && typeof v === "object"
        ? text((v as Record<string, unknown>)["#text"])
        : "";
const array = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter(
    (x) => x && typeof x === "object",
  );
const plain = (v: unknown) =>
  text(v)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function parseNewsFeed(
  xml: string,
  publisher: string,
  retrievedAt: string,
): NewsSource[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("订阅格式无法解析");
  const doc = new XMLParser({
    ignoreAttributes: false,
    processEntities: true,
  }).parse(xml);
  const items = array(
    doc.rss?.channel?.item ?? doc.feed?.entry ?? doc["rdf:RDF"]?.item,
  );
  if (!doc.rss && !doc.feed && !doc["rdf:RDF"])
    throw new Error("不是 RSS/Atom 订阅");
  return items.slice(0, 100).map((r, i) => {
    const links = array(r.link);
    const url =
      text(r.link) ||
      text(
        links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate")?.[
          "@_href"
        ],
      );
    return {
      id: `feed-${i}`,
      title: plain(r.title),
      url,
      publisher,
      publishedAt:
        text(r.pubDate ?? r.published ?? r.updated ?? r["dc:date"]) || null,
      retrievedAt,
      text: plain(
        r.description ?? r.summary ?? r["content:encoded"] ?? r.content,
      ).slice(0, 3000),
      evidence: "feed" as const,
    };
  });
}
export async function fetchNewsFeeds(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sources: NewsSource[]; warnings: string[] }> {
  const results = await Promise.all(
    NEWS_FEEDS.map(async (f) => {
      try {
        const res = await fetchImpl(f.url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          redirect: "error",
          headers: {
            accept:
              "application/rss+xml,application/atom+xml,application/xml,text/xml",
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (Number(res.headers.get("content-length")) > 1_000_000)
          throw new Error("订阅过大");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("没有订阅内容");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_000_000) throw new Error("订阅过大");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const xml = Buffer.concat(chunks).toString("utf8");
        return {
          sources: parseNewsFeed(xml, f.name, new Date().toISOString()),
          warnings: [] as string[],
        };
      } catch {
        return {
          sources: [] as NewsSource[],
          warnings: [`${f.name} 订阅暂时不可用`],
        };
      }
    }),
  );
  return {
    sources: results.flatMap((r) => r.sources),
    warnings: results.flatMap((r) => r.warnings),
  };
}
