/**
 * Agent 方案 P0：实测已配置模型端点的 tools / jsonSchema / vision 能力，并写入 settings.modelCapabilities。
 * 每次 HTTP 计入该库的今日模型额度；不打印、不保存 API key。用独立开发库或经授权的生产库运行：
 *   npx tsx --env-file-if-exists=.env scripts/dev/probe-model-caps.mts
 * 数据库 schema 必须已迁移到当前版本（npm run migrate）。
 */
import { schemaProblem } from "../../src/repositories/db";
import { runModelCapabilityProbe } from "../../src/workflows/model-capabilities";

const problem = schemaProblem();
if (problem) {
  console.log(`RESULT: db_not_ready — ${problem}`);
  process.exit(1);
}

const r = await runModelCapabilityProbe();
if (!r.ok) {
  console.log(`RESULT: ${r.code} — ${r.message}`);
  process.exit(1);
}
const c = r.capabilities;
console.log(`model=${c.model} fingerprint=${c.endpointFingerprint} probedAt=${c.probedAt}`);
for (const key of ["text", "jsonSchema", "tools", "vision"] as const) {
  console.log(`${key}: ${c[key]}${c.details[key] ? ` — ${c.details[key]}` : ""}`);
}
if (c.details.note) console.log(`note: ${c.details.note}`);
console.log(`RESULT: text=${c.text} jsonSchema=${c.jsonSchema} tools=${c.tools} vision=${c.vision}`);
