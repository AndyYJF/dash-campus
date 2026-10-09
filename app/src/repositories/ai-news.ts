import crypto from "node:crypto";
import { getDb } from "./db";
import { getSetting } from "./settings";
import {
  AI_NEWS_POLICY_KEY,
  newsPolicySchema,
  type NewsRun,
} from "@/contracts/ai-news";
export function newsPolicy() {
  const s = getSetting(AI_NEWS_POLICY_KEY);
  return { policy: newsPolicySchema.parse(s.value ?? {}), version: s.version };
}
function map(r: Record<string, unknown>): NewsRun {
  return {
    id: String(r.id),
    trigger: r.trigger as NewsRun["trigger"],
    status: r.status as NewsRun["status"],
    days: Number(r.days),
    policyVersion: Number(r.policy_version),
    jobId: r.job_id as string | null,
    sources: JSON.parse(String(r.sources_json)),
    digest: r.digest_json ? JSON.parse(String(r.digest_json)) : null,
    warnings: JSON.parse(String(r.warnings_json)),
    integrationMode: r.integration_mode as string | null,
    errorMessage: r.error_message as string | null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    generatedAt: r.generated_at as string | null,
  };
}
export function getNewsRun(id: string): NewsRun | null {
  const r = getDb().prepare("SELECT * FROM ai_news_runs WHERE id=?").get(id) as
    Record<string, unknown> | undefined;
  return r ? map(r) : null;
}
export function listNewsRuns(limit = 10): NewsRun[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM ai_news_runs ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(Math.min(30, Math.max(1, limit))) as Record<string, unknown>[]
  ).map(map);
}
export function activeNewsRun(): NewsRun | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM ai_news_runs WHERE status IN ('queued','running') LIMIT 1",
    )
    .get() as Record<string, unknown> | undefined;
  return r ? map(r) : null;
}
export function latestNewsDigest(): NewsRun | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM ai_news_runs WHERE status IN ('ready','empty') ORDER BY generated_at DESC,rowid DESC LIMIT 1",
    )
    .get() as Record<string, unknown> | undefined;
  return r ? map(r) : null;
}
export function insertNewsRun(
  trigger: NewsRun["trigger"],
  days: number,
  version: number,
): NewsRun {
  const id = crypto.randomUUID(),
    t = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO ai_news_runs(id,trigger,status,days,policy_version,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?)",
    )
    .run(id, trigger, days, version, t, t);
  return getNewsRun(id)!;
}
export function updateNewsRun(
  id: string,
  fields: Partial<
    Pick<
      NewsRun,
      | "status"
      | "sources"
      | "digest"
      | "warnings"
      | "integrationMode"
      | "errorMessage"
      | "jobId"
      | "generatedAt"
    >
  >,
): void {
  const cols: Record<string, string> = {
    status: "status",
    sources: "sources_json",
    digest: "digest_json",
    warnings: "warnings_json",
    integrationMode: "integration_mode",
    errorMessage: "error_message",
    jobId: "job_id",
    generatedAt: "generated_at",
  };
  const entries = Object.entries(fields).filter(([k]) => cols[k]);
  if (!entries.length) return;
  getDb()
    .prepare(
      `UPDATE ai_news_runs SET ${entries.map(([k]) => `${cols[k]}=?`).join(",")},updated_at=? WHERE id=?`,
    )
    .run(
      ...entries.map(([k, v]) =>
        ["sources", "digest", "warnings"].includes(k) && v !== null
          ? JSON.stringify(v)
          : v,
      ),
      new Date().toISOString(),
      id,
    );
}
