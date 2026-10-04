/**
 * Agent 方案 P3：固定语料评测。
 *   录制回放（兼容性，不发 HTTP）：npx tsx scripts/eval-agent.mts --mode recorded [--split holdout] [--filter tag]
 *   真实推理（独立临时库，计请求预算）：MODEL_PROTOCOL/MODEL_ENDPOINT/MODEL_API_KEY/MODEL_NAME 由环境变量给出，
 *     npx tsx scripts/eval-agent.mts --mode live --budget 300 [--split holdout] [--filter tag] [--limit N] [--record]
 * live 先做一次能力探测（计入预算），再逐条在种子库副本上走真实投递管线；预算不足一份投递上限时剩余样本记 not_run。
 * --record 把每次 HTTP 的响应与提示词指纹写进 test/corpus/recordings/<model>.jsonl（只含合成语料的响应，不含请求原文与凭证）。
 * 报告写到 --out（默认 .planning/eval-<mode>-<时间>.json，不入库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCorpus } from "../test/corpus/schema";
import { fixtureFingerprint } from "../test/corpus/fixtures";
import { loadRecordings, runEval, saveRecordings, summarize, type CaseResult, type ModelConfig } from "../test/corpus/eval";
import { probeModelCapabilities } from "../src/integrations/model-capabilities";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : "true") : undefined;
};
const mode = flag("mode") === "live" ? "live" : flag("mode") === "rules" ? "rules" : "recorded";
const split = flag("split");
const tag = flag("filter");
const limit = flag("limit") ? Number(flag("limit")) : undefined;
const budget = Number(flag("budget") ?? 300);
const record = flag("record") === "true";

let entries = loadCorpus();
if (split && split !== "all") entries = entries.filter((e) => e.split === split);
if (tag) {
  const wanted = tag.split(",");
  entries = entries.filter((e) => wanted.some((w) => e.tags.includes(w) || e.id === w));
}
if (limit) entries = entries.slice(0, limit);

const slug = (m: string) => m.replace(/[^a-zA-Z0-9.-]+/g, "-");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-eval-"));
let model: ModelConfig | undefined;
let probeRequests = 0;
let recordingsFile: string;

if (mode === "live") {
  const { MODEL_PROTOCOL, MODEL_ENDPOINT, MODEL_API_KEY, MODEL_NAME } = process.env;
  if (MODEL_PROTOCOL !== "openai-chat" || !MODEL_ENDPOINT || !MODEL_API_KEY || !MODEL_NAME) {
    console.log("RESULT: not_configured — live 需要 MODEL_PROTOCOL=openai-chat、MODEL_ENDPOINT、MODEL_API_KEY、MODEL_NAME");
    process.exit(1);
  }
  let calls = 0;
  const counting: typeof fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    calls++;
    return fetch(u, init);
  }) as typeof fetch;
  const caps = await probeModelCapabilities({ endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME }, { fetchImpl: counting });
  probeRequests = calls;
  model = { endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME, jsonSchema: caps.jsonSchema, tools: caps.tools };
  console.log(`probe: tools=${caps.tools} jsonSchema=${caps.jsonSchema}（${calls} 次请求）`);
  recordingsFile = path.resolve("test/corpus/recordings", `${slug(MODEL_NAME)}.jsonl`);
} else if (mode === "rules") {
  recordingsFile = "";
} else {
  const dir = path.resolve("test/corpus/recordings");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  const pick = flag("recordings") ?? files[0];
  if (!pick) {
    console.log("RESULT: no_recordings — 还没有录制；先用 --mode live --record 生成");
    process.exit(1);
  }
  recordingsFile = path.resolve(dir, path.basename(pick));
}

const recordings = mode === "recorded" ? loadRecordings(recordingsFile) : undefined;
const line = (r: CaseResult) => `${r.status.padEnd(7)} ${r.id} ${r.split[0]} ${r.expectKind}→${r.observed.kind}${r.observed.ops.length ? `(${r.observed.ops.join(",")})` : ""} ${r.observed.routedBy ?? "-"} req=${r.requests} ${r.latencyMs}ms ${r.reasons.join("；").slice(0, 160)}`;
const { results, recordings: fresh, requestsUsed } = await runEval({ mode, entries, workDir, budget: budget - probeRequests, model, recordings, record, onCase: (r) => console.log(line(r)) });
for (const r of results.filter((x) => x.status === "not_run" || x.status === "stale")) console.log(line(r));

if (mode === "live" && record && model) {
  saveRecordings(recordingsFile, { kind: "header", model: model.model, fixture: fixtureFingerprint(), jsonSchema: model.jsonSchema, tools: model.tools, createdAt: new Date().toISOString() }, fresh);
  console.log(`recordings: ${path.relative(process.cwd(), recordingsFile)}（本次 ${fresh.length} 条）`);
}

const summary = summarize(results);
const out = flag("out") ?? path.resolve(".planning", `eval-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ mode, model: model?.model ?? recordings?.header.model ?? null, fixture: fixtureFingerprint(), filter: { split: split ?? "all", tag: tag ?? null, limit: limit ?? null }, budget, requestsUsed: requestsUsed + probeRequests, summary, results }, null, 2));
fs.rmSync(workDir, { recursive: true, force: true });

console.log("\n== summary");
console.log(JSON.stringify({ ...summary, failures: undefined }, null, 2));
console.log(`requests used: ${requestsUsed + probeRequests} / budget ${mode === "live" ? budget : "-"}`);
console.log(`report: ${out}`);
const s = summary.bySplit;
console.log(`RESULT: mode=${mode} dev=${s.dev!.pass}/${s.dev!.ran} (${s.dev!.accuracy}) holdout=${s.holdout!.pass}/${s.holdout!.ran} (${s.holdout!.accuracy}) not_run=${s.dev!.notRun + s.holdout!.notRun} stale=${s.dev!.stale + s.holdout!.stale} readOnlyViolations=${summary.readOnlyViolations.length} clockRejections=${summary.clockRejections.length}`);
