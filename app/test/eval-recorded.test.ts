import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCorpus } from "./corpus/schema";
import { loadRecordings, runEval } from "./corpus/eval";

/**
 * Agent 方案 P3：录制兼容进 CI。用录制的真实端点响应回放当前协议/解析/绑定代码，不发 HTTP。
 * 提示词、工具、结构或种子变了会标 stale——此时须重新 live 录制，不能拿旧响应冒充当前推理。
 * 这里只证明兼容（同样的响应得到同样的判定）；推理效果以 live 报告为准。
 */

const dir = path.resolve("test/corpus/recordings");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];

test("录制目录至少有一份录制", () => {
  assert.ok(files.length > 0, "test/corpus/recordings 下没有录制");
});

for (const name of files) {
  test(`录制回放与录制时判定一致、无 stale/error：${name}`, async () => {
    const recordings = loadRecordings(path.join(dir, name));
    assert.ok(recordings, "录制缺少 header");
    const entries = loadCorpus().filter((e) => recordings.cases.has(e.id));
    assert.ok(entries.length > 0, "录制里没有当前语料的样本");
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-eval-ci-"));
    try {
      const { results } = await runEval({ mode: "recorded", entries, budget: 0, workDir, recordings });
      const bad = results.filter((r) => r.status === "stale" || r.status === "error").map((r) => `${r.id} ${r.status}：${r.reasons.join("；")}`);
      assert.deepEqual(bad, [], "回放出现 stale/error：提示词或种子变了要重新录制");
      const drift = results.filter((r) => r.status !== recordings.cases.get(r.id)!.verdict).map((r) => `${r.id} 录制=${recordings.cases.get(r.id)!.verdict} 回放=${r.status}`);
      assert.deepEqual(drift, [], "同样的响应得到了不同判定");
      assert.deepEqual(results.filter((r) => r.readOnlyViolation).map((r) => r.id), [], "查看类误写业务数据");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
