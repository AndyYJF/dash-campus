import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateAll, getDb, closeDb } from "./helpers";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { receiveIntake, retryIntake, runIntakeProcessJob } from "@/workflows/intake";
import { claimDueJobs } from "@/repositories/jobs";
import { getIntake } from "@/repositories/intakes";
import { saveUrlImage, saveAttachments, MAX_FILES } from "@/workflows/intake-files";

test("网页图片：模型失败后关闭连接并重试，复用同一份原始图片，不重新抓网页或重复保存", async () => {
  migrateAll();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const modelImages: string[][] = [];
  // 合成传输样本，仅验证字节保留和重试管线，不证明模型的图片识别能力。
  const bytes = Buffer.alloc(9 * 1024, 7);
  globalThis.fetch = async (input) => {
    fetchCount++;
    const url = String(input);
    return url.endsWith(".png")
      ? new Response(bytes, { headers: { "content-type": "image/png" } })
      : new Response('<h1>本科校历</h1><img src="/__local/calendar.png">', { headers: { "content-type": "text/html" } });
  };
  setProvidersForTests({ model: { mode: "fixture", provider: new FakeModelProvider((req) => {
    modelImages.push((req.context as { images: string[] }).images);
    return { ok: false, error: { code: "HTTP_ERROR", message: "controlled model failure", retryable: true } };
  }) } });
  try {
    const input = receiveIntake({ channel: "web", text: "请读取本科校历", urls: ["https://93.184.216.34/calendar.html"] });
    const first = claimDueJobs(new Date().toISOString(), 1)[0]!;
    await runIntakeProcessJob(first);
    assert.equal(modelImages[0]!.length, 1);
    assert.equal(fetchCount, 2);
    closeDb();
    const retry = retryIntake(input.intakeId, getIntake(input.intakeId)!.version);
    assert.equal(retry.kind, "requeued");
    await runIntakeProcessJob(claimDueJobs(new Date().toISOString(), 1)[0]!);
    assert.deepEqual(modelImages[1], modelImages[0]);
    assert.equal(fetchCount, 2, "重试不重新下载会变化的网页/图片");
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM intake_attachments WHERE intake_id = ?").get(input.intakeId) as { n: number }).n, 1);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM extracted_documents WHERE intake_id = ? AND source_kind = 'url-image'").get(input.intakeId) as { n: number }).n, 1);
  } finally {
    globalThis.fetch = originalFetch;
    setProvidersForTests({ model: undefined });
  }
});

test("网页图片与用户附件共享限额；同一内容复用 blob 并保留来源", () => {
  const input = receiveIntake({ channel: "web", text: "限额样本" });
  saveAttachments(input.intakeId, Array.from({ length: MAX_FILES }, (_, i) => ({ name: `${i}.txt`, mediaType: "text/plain", bytes: Buffer.from(`file-${i}`) })));
  assert.equal(saveUrlImage(input.intakeId, "https://example.com", "https://example.com/new.png", "data:image/png;base64,YWJj"), false);
  const second = receiveIntake({ channel: "web", text: "去重样本" });
  assert.equal(saveUrlImage(second.intakeId, "https://example.com", "https://example.com/1.png", "data:image/png;base64,YWJj"), true);
  assert.equal(saveUrlImage(second.intakeId, "https://example.com", "https://example.com/2.png", "data:image/png;base64,YWJj"), true);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM intake_attachments WHERE intake_id = ?").get(second.intakeId) as { n: number }).n, 1);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM extracted_documents WHERE intake_id = ? AND source_kind = 'url-image'").get(second.intakeId) as { n: number }).n, 2);
});
