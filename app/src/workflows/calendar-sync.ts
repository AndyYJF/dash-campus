import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { nowDate } from "@/domain/clock";
import { addDays, instanceTimezone, localDateInTz } from "@/domain/time";
import { isOfficialHolidaySource, parseHolidayNotice } from "@/domain/holiday-notice";
import { activeHolidayDataset } from "@/repositories/calendar-facts";
import { completeJob, createJob, failJob, leaseValid } from "@/repositories/jobs";
import { ensureOpenQuestion, questionEverAsked } from "@/repositories/questions";
import { resolveSearchProvider } from "@/integrations";
import { executeOperation } from "@/workflows/commands";
import { fetchUrl, type UrlFetch } from "@/workflows/intake-files";
import { calendarSyncPolicy } from "@/workflows/ops/calendar";
import { receiveIntake } from "@/workflows/intake";
import type { JobRow } from "@/contracts/jobs";

/**
 * 校历与节假日的有限来源刷新（ACADEMIC-CALENDAR-AND-HOLIDAYS §4.2）：
 * - 当年必查；10 月起查下一年度；未发布就是“未发布”，不沿用上一年、不预测；
 * - 先比内容摘要，无变化不解析、不调模型、不重排；
 * - 403/断网/解析失败：保留上一版数据，记录失败并有限退避；失败不等于“全年无节假日”；
 * - 只有发布机关域名算官方来源；撤销过的修订靠墓碑不被重新套用（执行器里判断）。
 */

export const CALENDAR_SYNC_JOB_TYPE = "calendar_sync";

export type SyncStatus = "ok" | "unchanged" | "not_published" | "failed" | "no_source" | "needs_review" | "not_due";
export type SyncOutcome = { kind: "holiday" | "academic"; scopeKey: string; status: SyncStatus; detail: string };

type Fetcher = (url: string) => Promise<UrlFetch>;
let fetcherOverride: Fetcher | null = null;
/** 仅测试用：替换网络抓取 */
export function setCalendarFetcherForTests(f: Fetcher | null): void {
  fetcherOverride = f;
}

const now = () => new Date().toISOString();
const HOUR = 3600_000;

type SourceRow = { id: string; url: string; last_hash: string | null; last_status: string; failure_count: number; next_check_at: string | null };

function sourceRow(kind: "holiday" | "academic", scopeKey: string): SourceRow {
  const db = getDb();
  const existing = db.prepare(`SELECT id, url, last_hash, last_status, failure_count, next_check_at FROM calendar_sync_sources WHERE kind = ? AND scope_key = ?`).get(kind, scopeKey) as SourceRow | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO calendar_sync_sources (id, kind, scope_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, kind, scopeKey, now(), now());
  return { id, url: "", last_hash: null, last_status: "never", failure_count: 0, next_check_at: null };
}

function record(id: string, patch: { url?: string; hash?: string | null; status: SyncStatus; error?: string | null; failureCount: number; nextCheckAt: string }): void {
  getDb()
    .prepare(
      `UPDATE calendar_sync_sources SET url = COALESCE(?, url), last_hash = COALESCE(?, last_hash), last_status = ?, last_error = ?, failure_count = ?, next_check_at = ?, last_checked_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    )
    .run(patch.url ?? null, patch.hash ?? null, patch.status, patch.error ?? null, patch.failureCount, patch.nextCheckAt, now(), now(), id);
}

/** 失败退避：1h、2h、4h … 封顶 3 天；不无限重试也不放弃 */
function backoff(at: Date, failures: number): string {
  return new Date(at.getTime() + Math.min(HOUR * 2 ** Math.max(0, failures - 1), 72 * HOUR)).toISOString();
}

async function discoverHolidayUrl(year: number): Promise<string | null> {
  const search = resolveSearchProvider();
  if (!search) return null;
  try {
    const hits = await search.provider.search({ query: `国务院办公厅关于${year}年部分节假日安排的通知`, maxResults: 5 });
    return hits.find((h) => isOfficialHolidaySource(h.url) && h.title.includes(String(year)))?.url ?? null;
  } catch {
    return null;
  }
}

/** 核对某一年度的国家节假日安排 */
export async function syncHolidayYear(year: number, at: Date, opts: { force?: boolean } = {}): Promise<SyncOutcome> {
  const policy = calendarSyncPolicy();
  const src = sourceRow("holiday", String(year));
  const interval = policy.intervalDays * 24 * HOUR;
  if (!opts.force && src.next_check_at && src.next_check_at > at.toISOString()) return { kind: "holiday", scopeKey: String(year), status: "not_due", detail: "还没到下次核对时间" };
  const done = (status: SyncStatus, detail: string, extra: Partial<Parameters<typeof record>[1]> = {}): SyncOutcome => {
    const failing = status === "failed";
    const failureCount = failing ? src.failure_count + 1 : 0;
    record(src.id, { status, error: failing || status === "needs_review" || status === "no_source" ? detail : null, failureCount, nextCheckAt: failing ? backoff(at, failureCount) : new Date(at.getTime() + interval).toISOString(), ...extra });
    return { kind: "holiday", scopeKey: String(year), status, detail };
  };

  const url = policy.holidayUrls[String(year)] || src.url || (await discoverHolidayUrl(year));
  if (!url) {
    const thisYear = Number(localDateInTz(at, instanceTimezone()).slice(0, 4));
    // 下一年度还没找到公告：就是未发布，按周再查；当年没有来源：问一次，接受链接或上传原件
    if (year > thisYear) return done("not_published", `${year} 年的安排还没有找到官方公告，按周再查；不沿用上一年、不预测`);
    const key = `calendar.holiday_source:${year}`;
    if (!activeHolidayDataset(year) && !questionEverAsked(key)) {
      ensureOpenQuestion({ questionKey: key, intakeId: null, itemId: null, fieldPath: "calendar.holiday_source", prompt: `还没有 ${year} 年节假日安排的官方来源。可以把国务院办公厅通知的链接或原文贴到输入框，我来核对入库。`, options: [], purpose: "info", reason: "没有官方来源就不能标注节假日和调休，也不会拿猜的日期顶替", context: { year } });
    }
    return done("no_source", `没有 ${year} 年节假日安排的官方来源`);
  }

  const fetched = await (fetcherOverride ?? fetchUrl)(url);
  if (!fetched.ok) return done("failed", `${fetched.error}（保留上一版数据，稍后重试；也可以直接上传通知原文）`, { url });
  const hash = crypto.createHash("sha256").update(fetched.text).digest("hex");
  if (src.last_hash === hash && src.last_status !== "failed") return done("unchanged", "来源没有变化", { url });
  const parsed = parseHolidayNotice(fetched.text);
  if (!parsed.ok) {
    return /没有找到标题/.test(parsed.error) ? done("not_published", `页面还不是 ${year} 年的安排通知`, { url }) : done("needs_review", `抓到了页面但没读懂：${parsed.error}`, { url, hash });
  }
  if (parsed.notice.year !== year) return done("needs_review", `页面是 ${parsed.notice.year} 年的通知，不是 ${year} 年的`, { url });
  const origin = isOfficialHolidaySource(fetched.finalUrl) ? "official" : "third_party";
  const outcome = executeOperation(
    { command: "sync_holiday_calendar", year, days: parsed.notice.days, sourceUrl: fetched.finalUrl, sourceTitle: parsed.notice.title, revisionHash: parsed.notice.revisionHash, origin, publishedAt: parsed.notice.publishedAt },
    { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: fetched.finalUrl, explicit: false, now: at },
  );
  if (!outcome.result.ok) return done("needs_review", outcome.result.error, { url, hash });
  return done(outcome.result.noChange ? "unchanged" : "ok", outcome.result.summary, { url, hash });
}

/** 学校校历/通知入口：内容没变不调模型；变了就作为一份来源材料进入统一输入管线 */
export async function syncAcademicSource(at: Date, opts: { force?: boolean } = {}): Promise<SyncOutcome | null> {
  const policy = calendarSyncPolicy();
  if (!policy.academicUrl) return null;
  const scopeKey = policy.school || policy.academicUrl;
  const src = sourceRow("academic", scopeKey);
  if (!opts.force && src.next_check_at && src.next_check_at > at.toISOString()) return { kind: "academic", scopeKey, status: "not_due", detail: "还没到下次核对时间" };
  // 临近已知假期的 14 天内每天核对学校通知入口，平时按设定间隔
  const today = localDateInTz(at, instanceTimezone());
  const nearHoliday = Boolean(getDb().prepare(`SELECT 1 FROM holiday_days d JOIN holiday_datasets s ON s.id = d.dataset_id WHERE s.status = 'active' AND d.kind = 'holiday' AND d.local_date > ? AND d.local_date <= ?`).get(today, addDays(today, 14)));
  const interval = (nearHoliday ? 1 : policy.intervalDays) * 24 * HOUR;
  const fetched = await (fetcherOverride ?? fetchUrl)(policy.academicUrl);
  if (!fetched.ok) {
    const failureCount = src.failure_count + 1;
    record(src.id, { url: policy.academicUrl, status: "failed", error: fetched.error, failureCount, nextCheckAt: backoff(at, failureCount) });
    return { kind: "academic", scopeKey, status: "failed", detail: `${fetched.error}（保留已入库的校历，稍后重试）` };
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify([fetched.text, fetched.images])).digest("hex");
  const nextCheckAt = new Date(at.getTime() + interval).toISOString();
  if (src.last_hash === hash) {
    record(src.id, { url: policy.academicUrl, status: "unchanged", failureCount: 0, nextCheckAt });
    return { kind: "academic", scopeKey, status: "unchanged", detail: "来源没有变化" };
  }
  getDb().transaction(() => {
    receiveIntake({ channel: "source", text: `学校校历/通知入口有更新，请核对：${policy.school}`.trim(), urls: [policy.academicUrl] });
    record(src.id, { url: policy.academicUrl, hash, status: "ok", failureCount: 0, nextCheckAt });
  })();
  return { kind: "academic", scopeKey, status: "ok", detail: "来源有更新，已作为材料进入处理" };
}

/** 一轮核对：当年必查；10 月起查下一年；学校入口按间隔/临近假期每日 */
export async function runCalendarSync(at: Date, opts: { force?: boolean } = {}): Promise<SyncOutcome[]> {
  const local = localDateInTz(at, instanceTimezone());
  const year = Number(local.slice(0, 4));
  const years = Number(local.slice(5, 7)) >= 10 ? [year, year + 1] : [year];
  const out: SyncOutcome[] = [];
  for (const y of years) out.push(await syncHolidayYear(y, at, opts));
  const academic = await syncAcademicSource(at, opts);
  if (academic) out.push(academic);
  return out;
}

/** 开启自动更新后每天最多排一次核对任务（入队本身不发请求；hold 期间调度器不会走到这里） */
export function scheduleCalendarSync(): void {
  if (!calendarSyncPolicy().enabled) return;
  const today = localDateInTz(nowDate(), instanceTimezone());
  createJob({ type: CALENDAR_SYNC_JOB_TYPE, dedupeKey: `calendar_sync:${today}`, runAt: new Date().toISOString(), payload: {} });
}

export async function runCalendarSyncJob(job: JobRow): Promise<{ kind: string }> {
  const token = job.leaseToken!;
  try {
    const outcomes = await runCalendarSync(nowDate());
    const nowIso = new Date().toISOString();
    if (leaseValid(job.id, token, job.generation, nowIso)) completeJob(job.id, token, job.generation, { kind: "skipped", reason: `calendar_sync:${outcomes.map((o) => `${o.kind}/${o.scopeKey}=${o.status}`).join(",")}` }, nowIso);
    return { kind: "done" };
  } catch (e) {
    const nowIso = new Date().toISOString();
    if (leaseValid(job.id, token, job.generation, nowIso)) failJob(job.id, token, job.generation, `CALENDAR_SYNC:${e instanceof Error ? e.message : String(e)}`, nowIso);
    return { kind: "failed" };
  }
}

/** 页面与 Agent 查询：每个来源上次什么时候核对、结果如何 */
export function calendarSyncStatus(): Array<{ kind: string; scopeKey: string; url: string; status: string; checkedAt: string | null; error: string | null; nextCheckAt: string | null }> {
  const rows = getDb().prepare(`SELECT kind, scope_key, url, last_status, last_checked_at, last_error, next_check_at FROM calendar_sync_sources ORDER BY kind, scope_key`).all() as Array<Record<string, string | null>>;
  return rows.map((r) => ({ kind: r.kind!, scopeKey: r.scope_key!, url: r.url ?? "", status: r.last_status!, checkedAt: r.last_checked_at, error: r.last_error, nextCheckAt: r.next_check_at }));
}
