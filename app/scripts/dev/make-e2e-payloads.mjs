#!/usr/bin/env node
/**
 * 生成 P1 e2e 请求体（中文内容只能走文件，Windows argv 边界会把 UTF-8 参数转 GBK）。
 * 用法：node scripts/dev/make-e2e-payloads.mjs <outDir>
 */
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("用法：node make-e2e-payloads.mjs <outDir>");
  process.exit(1);
}

const mixed = [
  "SDCT1",
  "T=20",
  "P=1,08:15-09:00;2,09:10-09:55",
  "C=高等数学|张老师|A101|1|1-2|1-16|A|-",
  "今天跑了40分钟，环境一直报错",
].join("\n");

fs.writeFileSync(path.join(outDir, "create.json"), JSON.stringify({ text: mixed }));
fs.writeFileSync(
  path.join(outDir, "answer.json"),
  JSON.stringify({ text: "第5周", expectedVersion: Number(process.argv[3] ?? 1) }),
);
console.log("written: create.json answer.json");
