/**
 * Agent 方案 P3：把主人“理解错了”的纠错导出成语料草稿。
 *   DATABASE_PATH=<库> npx tsx scripts/export-feedback.mts [--all] [--out .planning/feedback-<时间>.jsonl]
 * 草稿写到 .planning/（不入库）；原话含私人内容，人工脱敏并标注 expect 后才能挪进 test/corpus/utterances.jsonl。
 * 导出后标 exported_at，下次只导出新的；--all 连已导出的一起再导一份。
 */
import fs from "node:fs";
import path from "node:path";
import { exportFeedbackDrafts } from "../src/workflows/agent-feedback";
import { closeDb } from "../src/repositories/db";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : `.planning/feedback-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const drafts = exportFeedbackDrafts({ all: args.includes("--all") });
closeDb();
if (!drafts.length) {
  console.log("没有新的纠错记录");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, drafts.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
  console.log(`导出 ${drafts.length} 条草稿：${out}`);
}
