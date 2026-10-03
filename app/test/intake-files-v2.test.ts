import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { listItems } from "@/repositories/intakes";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";

/**
 * Agent-first V2 P4 行为测试（MASTER-PLAN §3 输入协议、§10 P4 退出条件）：
 * 附件限额明确失败；ICS 确定性入库可撤销；CSV 走分类；图片走 vision；同 hash blob 去重但不去重用户意图。
 */

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:ics-1@dash",
  "DTSTART:20261008T140000",
  "DTEND:20261008T153000",
  "SUMMARY:操作系统前沿讲座",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

let sessionToken = "";
let csrfToken = "";
let visionCalls = 0;

function multipartReq(url: string, form: FormData, key?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${sessionToken}`,
      "x-csrf-token": csrfToken,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: form,
  });
}

function jsonReq(url: string, body: unknown, key: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

function fileOf(name: string, type: string, content: string | Uint8Array): File {
  return new File([content as BlobPart], name, { type });
}

before(() => {
  migrateAll();
  createOwner(hashPassword("p4-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        const ctx = req.context as { text?: string; images?: string[] };
        if (ctx.images?.length) visionCalls++;
        const text = ctx.text ?? "";
        return { ok: true, validatedResult: { items: [{ itemKey: "f-1", kind: "practice", summary: text.slice(0, 30) || "图片内容", excerpt: text.trim().slice(0, 100) || "图片" }] } };
      }),
    },
  });
});

test("P4：超限附件明确失败（413 尺寸 / 422 数量）", async () => {
  const big = new FormData();
  big.append("files", fileOf("big.bin", "application/octet-stream", new Uint8Array(10 * 1024 * 1024 + 1)));
  const r1 = await createIntakeRoute(multipartReq("/api/v2/intakes", big, "idem-p4-big"));
  assert.equal(r1.status, 413);

  const many = new FormData();
  for (let i = 0; i < 11; i++) many.append("files", fileOf(`f${i}.txt`, "text/plain", `内容${i}`));
  const r2 = await createIntakeRoute(multipartReq("/api/v2/intakes", many, "idem-p4-many"));
  assert.equal(r2.status, 422);
});

test("P4：ICS 附件确定性解析入库，undo 可撤销", async () => {
  const form = new FormData();
  form.append("files", fileOf("events.ics", "text/calendar", ICS));
  const res = await createIntakeRoute(multipartReq("/api/v2/intakes", form, "idem-p4-ics"));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();

  const events = getDb().prepare(`SELECT * FROM fixed_events WHERE title LIKE '%操作系统前沿%'`).all() as Array<{ id: string; event_date: string; local_start: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event_date, "2026-10-08");
  assert.equal(events[0]!.local_start, "14:00");

  const item = listItems(intakeId).find((i) => i.kind === "ics")!;
  assert.equal(item.state, "applied");
  const batchId = (item.payload.applied as { batchId: string }).batchId;
  const { undoBatch } = await import("@/workflows/undo");
  assert.equal(undoBatch(batchId).kind, "undone");
  const gone = getDb().prepare(`SELECT COUNT(*) AS n FROM fixed_events WHERE title LIKE '%操作系统前沿%'`).get() as { n: number };
  assert.equal(gone.n, 0);
});

test("P4：CSV 附件走文本分类落实践记录；不同日期同内容不去重", async () => {
  const csv = "日期,事项,分钟\n2026-10-01,学数学,40";
  for (const [i, ref] of [["a", "2026-10-01"], ["b", "2026-10-02"]] as const) {
    const form = new FormData();
    form.append("files", fileOf("log.csv", "text/csv", csv));
    form.append("referenceDate", ref);
    const res = await createIntakeRoute(multipartReq("/api/v2/intakes", form, `idem-p4-csv-${i}`));
    assert.equal(res.status, 202);
  }
  for (let i = 0; i < 6; i++) await runDueJobsOnce();
  const practices = getDb().prepare(`SELECT COUNT(*) AS n FROM practice_entries`).get() as { n: number };
  assert.ok(practices.n >= 2, "不同日期的相同汇报是不同记录，不按文字 hash 去重");
  const csvHash = (await import("node:crypto")).createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex");
  const blobs = getDb().prepare(`SELECT COUNT(*) AS n FROM intake_blobs WHERE hash = ?`).get(csvHash) as { n: number };
  assert.equal(blobs.n, 1, "同 hash 文件 blob 只存一份");
});

test("P4：图片附件走 vision 提取", async () => {
  const png1x1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("files", fileOf("timetable.png", "image/png", png1x1));
  const res = await createIntakeRoute(multipartReq("/api/v2/intakes", form, "idem-p4-img"));
  assert.equal(res.status, 202);
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  assert.equal(visionCalls, 1, "图片应触发一次 vision 调用");
});

test("P4：URL 提取正文进入分类（data: URL 确定性）", async () => {
  const text = "今天复习了操作系统一小时";
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  const res = await createIntakeRoute(jsonReq("/api/v2/intakes", { urls: [url] }, "idem-p4-url"));
  assert.equal(res.status, 202);
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  const docs = getDb().prepare(`SELECT COUNT(*) AS n FROM extracted_documents WHERE source_kind = 'url'`).get() as { n: number };
  assert.equal(docs.n, 1);
});

test("P4：PDF 暂不支持，明确失败且原文保留（不静默丢）", async () => {
  const form = new FormData();
  form.append("files", fileOf("doc.pdf", "application/pdf", "%PDF-1.4 fake"));
  const res = await createIntakeRoute(multipartReq("/api/v2/intakes", form, "idem-p4-pdf"));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  const item = listItems(intakeId).find((i) => i.state === "failed");
  assert.ok(item, "PDF 应产生明确的失败事项");
  assert.match(item!.evidence?.error as string, /PDF|不支持/);
});
