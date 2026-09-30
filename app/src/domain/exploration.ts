import crypto from "node:crypto";
import { addDays, localDateInTz, wallTimeToUtc } from "@/domain/time";

/**
 * 探索纯规则（计划 v1.2 第 7.2 节）。
 */

/** 明确的追踪参数；其余 query 视为语义参数保留（不能把不同课程页合并） */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "spm", "from", "share_source", "share_medium",
]);

/**
 * canonical URL：只去 fragment、明确的追踪参数和默认端口；主机名小写。
 * 保留路径大小写与语义 query 的原有顺序。
 */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

/** 比较用的空白归一化（全角空格、换行、连续空白） */
function normalizeWs(s: string): string {
  return s.replace(/[\s　]+/g, " ").trim();
}

/** 程序验证片段存在于证据文本（7.2）；返回原文中的起始位置，不存在返回 -1 */
export function locateQuote(evidenceText: string, quote: string): number {
  const q = normalizeWs(quote);
  if (!q) return -1;
  return normalizeWs(evidenceText).indexOf(q);
}

/** evidence_hash 使用本次用于推荐的事实摘录（页面导航变化不算新机会） */
export function evidenceHash(quotes: string[]): string {
  const normalized = quotes.map(normalizeWs).filter(Boolean).sort();
  return crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeWs(text)).digest("hex");
}

/**
 * 定期探索的下一次运行时刻：当地时区下一个 weekday(1=周一..7=周日) 的 localTime，严格晚于 after。
 * 错过多个周期只生成一个当前 run：调用方以"现在"为 after 计算，不补跑历史周期。
 */
export function nextWeeklyRun(after: Date, weekday: number, localTime: string, tz: string): string {
  const today = localDateInTz(after, tz);
  const dow = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1..7
  for (let i = 0; i <= 7; i++) {
    const offset = (weekday - dow + 7) % 7 + (i === 0 ? 0 : 7 * i);
    const candidate = wallTimeToUtc(addDays(today, offset), localTime, tz);
    if (candidate.getTime() > after.getTime()) return candidate.toISOString();
  }
  // 理论不可达：兜底一周后
  return new Date(after.getTime() + 7 * 86_400_000).toISOString();
}
