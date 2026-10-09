import assert from "node:assert/strict";
import { completeWithSchema } from "@/integrations/model-json";
import { before, beforeEach, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { parseNewsFeed, fetchNewsFeeds } from "@/integrations/news-feeds";
import { newsUrl, prepareNews, validateNewsDigest } from "@/domain/ai-news";
import {
  type NewsSource,
  AI_NEWS_POLICY_KEY,
  AI_NEWS_SCHEDULE_KEY,
} from "@/contracts/ai-news";
import { startNews, runNewsJob, scheduleNews } from "@/workflows/ai-news";
import {
  getNewsRun,
  latestNewsDigest,
  newsPolicy,
} from "@/repositories/ai-news";
import { claimDueJobs, getJob } from "@/repositories/jobs";
import { setProvidersForTests } from "@/integrations";
import type { ModelProvider, ModelRequest } from "@/contracts/model";
import { getSetting, updateSetting } from "@/repositories/settings";
import { executeCommand } from "@/workflows/commands";
import { factsHash } from "@/workflows/command-facts";
import { AgentToolbox, TOOL_RESULT_LIMIT } from "@/workflows/agent-tools";
import { applyRestoreHold, resumeAfterRestore } from "@/workflows/restore";
import { setNowForTests } from "@/domain/clock";
import {
  FULL_JSON_TABLES,
  FULL_JSON_SETTINGS_OMIT_KEYS,
} from "@/contracts/exports";
import { intentSchema } from "@/domain/intent";
import { INTENT_COMMANDS } from "@/domain/intent-catalog";
const at = new Date("2026-10-09T04:00:00Z");
let calls = 0;
const source = (extra: Partial<NewsSource> = {}): NewsSource => ({
  id: "seed",
  title: "模型发布示例",
  url: "https://example.org/release",
  publisher: "Example",
  publishedAt: "2026-10-08T08:00:00Z",
  retrievedAt: at.toISOString(),
  text: "Released an open model with reproducible evaluation results. This is a synthetic test.",
  evidence: "feed",
  ...extra,
});
function digest(req: ModelRequest) {
  const sources = (req.context as { sources: NewsSource[] }).sources;
  return {
    stories: sources.slice(0, 1).map((s) => ({
      title: "合成模型发布",
      category: "model",
      summary: "测试资料记录了模型发布",
      relevance: "先了解公开评估方法",
      uncertainty: "仅用于流程测试",
      citations: [{ sourceId: s.id, quote: s.text.slice(0, 50) }],
    })),
  };
}
const provider: ModelProvider = {
  protocol: "test",
  async call(req) {
    calls++;
    return { ok: true, validatedResult: digest(req) };
  },
};
const feeds = async () => ({ sources: [source()], warnings: [] });
function claim() {
  return claimDueJobs(new Date(Date.now() + 1000).toISOString(), 1)[0]!;
}
const ctx = {
  intakeId: null,
  itemId: null,
  itemKey: "",
  instanceEpoch: 0,
  explicit: true,
  evidence: "owner",
};
const env = {
  intakeId: null,
  conversationId: null,
  referenceDate: "2026-10-09",
  now: at,
  tz: "Asia/Shanghai",
  selected: null,
};
before(() => migrateAll());
beforeEach(() => {
  getDb().exec(
    "DELETE FROM ai_news_runs; DELETE FROM jobs; DELETE FROM ai_request_ledger; DELETE FROM ai_usage; DELETE FROM agent_action_changes; DELETE FROM agent_action_batches; DELETE FROM settings; UPDATE instance_state SET restored_hold=0,deployment_epoch=0;",
  );
  calls = 0;
  setNowForTests(at);
  setProvidersForTests({ model: { provider, mode: "fixture" }, search: null });
});
test("RSS/Atom dates, plain text and original links survive; malformed/DTD rejected", () => {
  const rss = `<rss><channel><item><title>Release</title><link>https://example.org/a</link><pubDate>Thu, 08 Oct 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>Release &amp; details</p>]]></description></item></channel></rss>`;
  const rows = parseNewsFeed(rss, "Publisher", at.toISOString());
  assert.equal(rows[0].url, "https://example.org/a");
  assert.match(rows[0].text, /Release/);
  assert.ok(rows[0].publishedAt);
  const atom = parseNewsFeed(
    `<feed><entry><title>Paper</title><link href="https://example.org/paper"/><published>2026-10-08T00:00:00Z</published><summary>Research summary</summary></entry></feed>`,
    "Lab",
    at.toISOString(),
  );
  assert.equal(atom[0].url, "https://example.org/paper");
  assert.throws(() => parseNewsFeed("<!DOCTYPE rss><rss/>", "Bad", "now"));
  assert.throws(() => parseNewsFeed("<html>error</html>", "Bad", "now"));
});
test("fixed feeds report failures honestly; oversize input is bounded", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    return new Response("x", { headers: { "content-length": "2000000" } });
  }) as typeof fetch;
  const out = await fetchNewsFeeds(new AbortController().signal, f);
  assert.equal(n, 4);
  assert.equal(out.sources.length, 0);
  assert.equal(out.warnings.length, 4);
});
test("URL dedup and recent window exclude old/future/unknown/private links", () => {
  const prepared = prepareNews(
    [
      source(),
      source({ url: "https://example.org/release?utm_source=a#x" }),
      source({ url: "https://example.org/old", publishedAt: "2026-09-01" }),
      source({ url: "https://example.org/future", publishedAt: "2027-01-01" }),
      source({ url: "https://example.org/unknown", publishedAt: null }),
    ],
    at,
    7,
  );
  assert.equal(prepared.sources.length, 1);
  assert.equal(prepared.unknownDates, 1);
  assert.equal(newsUrl("http://example.org/a"), null);
  assert.equal(newsUrl("https://127.0.0.1/a"), null);
  assert.equal(newsUrl("https://localhost/a"), null);
});
test("one busy publisher cannot crowd all other sources out", () => {
  const list = Array.from({ length: 50 }, (_, i) =>
    source({ url: `https://example.org/${i}` }),
  );
  list.push(
    source({
      url: "https://other.org/a",
      publisher: "Other",
      publishedAt: "2026-10-03",
    }),
  );
  const out = prepareNews(list, at, 7);
  assert.equal(out.sources.length, 13);
  assert.ok(out.sources.some((s) => s.publisher === "Other"));
});
test("unknown source, invented quote and duplicate source story are rejected", () => {
  const sources = prepareNews([source()], at, 7).sources;
  const valid = digest({ context: { sources } } as ModelRequest);
  assert.equal(validateNewsDigest(valid, sources).stories.length, 1);
  const bad = structuredClone(valid);
  bad.stories[0].citations[0].sourceId = "invented";
  assert.throws(() => validateNewsDigest(bad, sources));
  bad.stories[0].citations[0] = {
    sourceId: sources[0].id,
    quote: "This quote never appeared",
  };
  assert.throws(() => validateNewsDigest(bad, sources));
  assert.throws(() =>
    validateNewsDigest(
      { stories: [valid.stories[0], valid.stories[0]] },
      sources,
    ),
  );
});
test("parallel manual requests share one run; incompatible window is explicit", () => {
  const a = startNews(),
    b = startNews();
  assert.equal(a.id, b.id);
  assert.throws(() => startNews(30), /已有资讯/);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number })
      .n,
    1,
  );
});
test("registered request finishes with saved source dates/citations; creates no study tasks", async () => {
  const out = executeCommand({ command: "request_ai_news", days: 7 }, ctx);
  assert.ok(out.ok);
  const job = claim();
  assert.equal((await runNewsJob(job, feeds)).kind, "done");
  const r = latestNewsDigest()!;
  assert.equal(r.status, "ready");
  assert.equal(r.digest?.stories.length, 1);
  assert.equal(r.integrationMode, "fixture");
  assert.equal(calls, 1);
  assert.equal(getJob(job.id)?.status, "done");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number })
      .n,
    0,
  );
  assert.equal(
    (
      getDb().prepare("SELECT COUNT(*) AS n FROM ai_request_ledger").get() as {
        n: number;
      }
    ).n,
    1,
  );
});
test("failed later refresh retains earlier successful digest", async () => {
  const old = startNews();
  await runNewsJob(claim(), feeds);
  setProvidersForTests({
    model: {
      provider: {
        protocol: "test",
        async call() {
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "timeout", retryable: true },
          };
        },
      },
      mode: "fixture",
    },
    search: null,
  });
  const next = startNews();
  await runNewsJob(claim(), feeds);
  assert.equal(getNewsRun(next.id)?.status, "failed");
  assert.equal(latestNewsDigest()?.id, old.id);
});
test("all feed failures cannot claim empty successful lookup", async () => {
  const r = startNews();
  await runNewsJob(claim(), async () => ({
    sources: [],
    warnings: Array.from({ length: 4 }, () => "订阅暂时不可用"),
  }));
  assert.equal(getNewsRun(r.id)?.status, "failed");
  assert.equal(latestNewsDigest(), null);
  assert.equal(calls, 0);
});
test("valid feeds with only old records finish empty without model call", async () => {
  const r = startNews();
  await runNewsJob(claim(), async () => ({
    sources: [source({ publishedAt: "2020-01-01" })],
    warnings: [],
  }));
  assert.equal(getNewsRun(r.id)?.status, "empty");
  assert.equal(calls, 0);
});
test("budget denied at admission starts nothing; depletion before model sends no model call", async () => {
  updateSetting("aiBudget", { dailyModelCalls: 0 }, 0);
  assert.throws(() => startNews(), /上限|额度|预算/);
  assert.equal(calls, 0);
  const s = getSetting("aiBudget");
  updateSetting("aiBudget", { dailyModelCalls: 10 }, s.version);
  const r = startNews();
  const b = getSetting("aiBudget");
  updateSetting("aiBudget", { dailyModelCalls: 0 }, b.version);
  await runNewsJob(claim(), feeds);
  assert.equal(calls, 0);
  assert.equal(getNewsRun(r.id)?.status, "failed");
});
test("scheduled work obeys total switch, uses local day and does not backfill", () => {
  updateSetting("aiBudget", { scheduledEnabled: false }, 0);
  scheduleNews(at);
  assert.equal(getNewsRun("missing"), null);
  assert.equal(getSetting(AI_NEWS_SCHEDULE_KEY).value, "2026-10-09");
  assert.equal(
    (
      getDb().prepare("SELECT COUNT(*) AS n FROM ai_news_runs").get() as {
        n: number;
      }
    ).n,
    0,
  );
  const b = getSetting("aiBudget");
  updateSetting("aiBudget", { scheduledEnabled: true }, b.version);
  scheduleNews(at);
  assert.equal(
    (
      getDb().prepare("SELECT COUNT(*) AS n FROM ai_news_runs").get() as {
        n: number;
      }
    ).n,
    0,
  );
  scheduleNews(new Date("2026-10-12T04:00:00Z"));
  scheduleNews(new Date("2026-10-12T05:00:00Z"));
  assert.equal(
    (
      getDb().prepare("SELECT COUNT(*) AS n FROM ai_news_runs").get() as {
        n: number;
      }
    ).n,
    1,
  );
});
test("daily job stops if policy changed before processing", async () => {
  scheduleNews(at);
  const job = claim();
  executeCommand({ command: "update_ai_news_policy", enabled: false }, ctx);
  await runNewsJob(job, feeds);
  const r = getNewsRun((job.payload as { runId: string }).runId)!;
  assert.equal(r.status, "cancelled");
  assert.equal(calls, 0);
});
test("cancellation while model is in flight cannot publish its late response", async () => {
  const r = startNews();
  setProvidersForTests({
    model: {
      provider: {
        protocol: "test",
        async call(req) {
          getDb()
            .prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?")
            .run(r.jobId);
          return { ok: true, validatedResult: digest(req) };
        },
      },
      mode: "fixture",
    },
    search: null,
  });
  await runNewsJob(claim(), feeds);
  assert.equal(getNewsRun(r.id)?.status, "cancelled");
  assert.equal(latestNewsDigest(), null);
});
test("lost lease cannot publish or fail the new worker's run", async () => {
  const r = startNews();
  setProvidersForTests({
    model: {
      provider: {
        protocol: "test",
        async call(req) {
          getDb()
            .prepare("UPDATE jobs SET generation=generation+1 WHERE id=?")
            .run(r.jobId);
          return { ok: true, validatedResult: digest(req) };
        },
      },
      mode: "fixture",
    },
    search: null,
  });
  const out = await runNewsJob(claim(), feeds);
  assert.equal(out.kind, "fenced");
  assert.equal(getNewsRun(r.id)?.status, "running");
  assert.equal(latestNewsDigest(), null);
});
test("already committed result is claimed after crash without second model call", async () => {
  const r = startNews();
  await runNewsJob(claim(), feeds);
  getDb()
    .prepare(
      "UPDATE jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=?",
    )
    .run(r.jobId);
  await runNewsJob(claim(), feeds);
  assert.equal(calls, 1);
  assert.equal(getNewsRun(r.id)?.status, "ready");
});
test("excessive recovery attempts stop before external requests", async () => {
  const r = startNews();
  getDb().prepare("UPDATE jobs SET attempt=2 WHERE id=?").run(r.jobId);
  let loads = 0;
  await runNewsJob(claim(), async () => {
    loads++;
    return feeds();
  });
  assert.equal(loads, 0);
  assert.equal(calls, 0);
  assert.equal(getNewsRun(r.id)?.status, "failed");
});
test("AI lookup is read-only, cited and bounded; malformed cursor is rejected", async () => {
  await runNewsJob((startNews(), claim()), feeds);
  const before = getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get();
  const box = new AgentToolbox(env);
  const titles = box.run("get_ai_news", {});
  assert.ok(titles.ok);
  assert.ok(titles.content.length <= TOOL_RESULT_LIMIT);
  const details = box.run("get_ai_news", { query: "合成模型" });
  assert.ok(details.ok);
  assert.match(details.content, /example.org/);
  assert.match(details.content, /先了解公开评估/);
  assert.deepEqual(
    getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get(),
    before,
  );
  assert.equal(box.run("get_ai_news", { cursor: "bad" }).ok, false);
});
test("owner policy changes have versioned facts, journal and intent catalog mappings", () => {
  const command = { command: "update_ai_news_policy", localTime: "09:30" };
  const before = factsHash(command);
  assert.ok(executeCommand(command, ctx).ok);
  assert.notEqual(factsHash(command), before);
  assert.equal(newsPolicy().policy.localTime, "09:30");
  assert.equal(
    executeCommand({ ...command, enabled: false, expectedVersion: 0 }, ctx).ok,
    false,
  );
  const stale = executeCommand(
    { ...command, enabled: false },
    { ...ctx, expectedFacts: before },
  );
  assert.equal(stale.ok, false);
  const intent = intentSchema.parse({ op: "ai_news" });
  assert.equal(intent.op, "ai_news");
  if (intent.op === "ai_news") assert.equal(intent.days, 7);
  assert.deepEqual(INTENT_COMMANDS.ai_news, ["request_ai_news"]);
  assert.ok(FULL_JSON_TABLES.ai_news_runs.omit?.includes("job_id"));
  assert.ok(FULL_JSON_SETTINGS_OMIT_KEYS.includes(AI_NEWS_SCHEDULE_KEY));
  assert.ok(getSetting(AI_NEWS_POLICY_KEY).version > 0);
});
test("restored hold blocks updates and resume cancels stale active run", () => {
  const r = startNews();
  applyRestoreHold(getDb(), "synthetic-backup");
  assert.throws(() => startNews(), /恢复/);
  scheduleNews(at);
  assert.equal(getSetting(AI_NEWS_SCHEDULE_KEY).version, 0);
  resumeAfterRestore(at);
  assert.equal(getNewsRun(r.id)?.status, "cancelled");
  assert.equal(getSetting(AI_NEWS_SCHEDULE_KEY).value, "2026-10-09");
  assert.ok(startNews().id !== r.id);
});

test("owner can stop queued news through registered operation", () => {
  const r = startNews();
  const out = executeCommand({ command: "cancel_ai_news" }, ctx);
  assert.ok(out.ok);
  assert.equal(getNewsRun(r.id)?.status, "cancelled");
  assert.equal(getJob(r.jobId!)?.status, "cancelled");
  assert.ok(startNews().id !== r.id);
});
test("owner can stop running news through registered operation", async () => {
  const r = startNews();
  const job = claim();
  const out = executeCommand({ command: "cancel_ai_news" }, ctx);
  assert.ok(out.ok);
  await runNewsJob(job, feeds);
  assert.equal(getNewsRun(r.id)?.status, "cancelled");
  assert.equal(calls, 0);
});
test("optional search uses news window, is metered and tolerates partial failure", async () => {
  let searches = 0;
  setProvidersForTests({
    model: { provider, mode: "fixture" },
    search: {
      mode: "fixture",
      provider: {
        provider: "test",
        async search(a) {
          searches++;
          assert.equal(a.topic, "news");
          assert.equal(a.days, 7);
          if (searches === 2) throw new Error("synthetic unavailable");
          return [
            {
              id: "search",
              title: "搜索摘要合成新闻",
              url: "https://other.org/paper",
              snippet:
                "A synthetic research announcement with reproducible results",
              publishedAt: "2026-10-08",
            },
          ];
        },
        async extract() {
          throw new Error("should not extract");
        },
      },
    },
  });
  const r = startNews();
  await runNewsJob(claim(), feeds);
  assert.equal(searches, 2);
  assert.equal(getNewsRun(r.id)?.status, "ready");
  assert.equal(getNewsRun(r.id)?.sources.length, 2);
  assert.ok(
    getNewsRun(r.id)?.warnings.some((s) => s.includes("补充新闻检索未完成")),
  );
});

test("default fixture workflow never fetches real feeds", async () => {
  const r = startNews();
  await runNewsJob(claim());
  assert.equal(getNewsRun(r.id)?.status, "ready");
  assert.ok(
    getNewsRun(r.id)?.sources.every((s) =>
      s.url.startsWith("https://example.org/fixture/"),
    ),
  );
  assert.ok(getNewsRun(r.id)?.warnings.some((w) => w.includes("合成资料")));
});

test("provider can repair an ungrounded quote once before publishing; both HTTP calls count", async () => {
  let attempts = 0;
  setProvidersForTests({ model: { mode: "fixture", provider: { protocol: "test", call: (req) => completeWithSchema(req, async () => {
    attempts++;
    const output = digest(req);
    if (attempts === 1) output.stories[0]!.citations[0]!.quote = "Translated or invented quote not present in this source";
    return { ok: true, text: JSON.stringify(output) };
  }) } }, search: null });
  const run = startNews();
  assert.equal((await runNewsJob(claim(), feeds)).kind, "done");
  assert.equal(getNewsRun(run.id)!.status, "ready");
  assert.equal(attempts, 2);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM ai_request_ledger").get() as { n: number }).n, 2);
});
test("persistently ungrounded quote stops after one repair, publishes nothing and retains previous digest", async () => {
  const previous = startNews();
  await runNewsJob(claim(), feeds);
  let attempts = 0;
  setProvidersForTests({ model: { mode: "fixture", provider: { protocol: "test", call: (req) => completeWithSchema(req, async () => {
    attempts++;
    const output = digest(req);
    output.stories[0]!.citations[0]!.quote = "Invented quote not present in the source";
    return { ok: true, text: JSON.stringify(output) };
  }) } }, search: null });
  const run = startNews();
  assert.equal((await runNewsJob(claim(), feeds)).kind, "failed");
  assert.equal(attempts, 2);
  assert.equal(getNewsRun(run.id)!.digest, null);
  assert.equal(latestNewsDigest()!.id, previous.id);
});
