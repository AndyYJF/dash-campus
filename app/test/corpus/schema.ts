import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * 固定语料条目格式（Agent 方案 §6 P0/P3）。只收公开示例与合成 fixture 句子；真实用户反馈须人工脱敏后才能进入。
 * - fixture：test/corpus/fixtures 下的种子名（P3 实现，固定时钟/课表/任务/目标集合）。
 * - expect.kind：路由结果类别（§2.1）——act 执行意图、decide 交给决策、ask 追问、material 交材料管线。
 * - expect.ops：act 时必须出现的意图 op；fields 只列关键字段，不要求逐字段相等。
 * - readOnly：不得产生任何业务写入（查看类零容忍）；allowAsk：追问也算正确。
 * - fallback：规则降级路径也必须给出同样结果（无模型时回归用）。
 * - turns：多轮旅程的前序轮次；expect 针对最后一轮 text。
 */

export const ROUTE_KINDS = ["act", "decide", "ask", "material"] as const;

export const corpusEntrySchema = z
  .object({
    id: z.string().regex(/^u\d{3,4}$/),
    split: z.enum(["dev", "holdout"]),
    text: z.string().min(1).max(2000),
    fixture: z.string().default("week-basic"),
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-10-12"),
    now: z.string().default("2026-10-12T18:30:00+08:00"),
    selected: z.object({ entityKind: z.string(), name: z.string() }).nullable().default(null),
    turns: z.array(z.object({ role: z.enum(["owner", "agent"]), text: z.string().min(1) })).default([]),
    expect: z.object({
      kind: z.enum(ROUTE_KINDS),
      ops: z.array(z.string()).default([]),
      fields: z.record(z.string(), z.unknown()).default({}),
      readOnly: z.boolean().default(false),
      allowAsk: z.boolean().default(false),
    }),
    source: z.string().min(1),
    tags: z.array(z.string()).min(1),
    fallback: z.boolean().default(false),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.expect.kind === "act" && e.expect.ops.length === 0) ctx.addIssue({ code: "custom", message: "act 需要列出 ops" });
    if (e.expect.ops.length && e.expect.ops.every((op) => op === "inspect") && !e.expect.readOnly) ctx.addIssue({ code: "custom", message: "纯查看必须 readOnly" });
  });

export type CorpusEntry = z.infer<typeof corpusEntrySchema>;

export const CORPUS_PATH = path.resolve(process.cwd(), "test/corpus/utterances.jsonl");

export function loadCorpus(file = CORPUS_PATH): CorpusEntry[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line, i) => {
      const parsed = corpusEntrySchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`第 ${i + 1} 行不合法：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      return parsed.data;
    });
}
