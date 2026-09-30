import crypto from "node:crypto";
import type { ModelProvider, ModelRequest, ModelResult } from "@/contracts/model";
import type { EvidenceDocument, SearchHit, SearchProvider } from "@/contracts/search";
import { MODEL_WORKFLOW_CANDIDATES, MODEL_WORKFLOW_PLAN } from "@/contracts/exploration";
import { MODEL_WORKFLOW_BLOCKER, MODEL_WORKFLOW_REVIEW } from "@/contracts/review";
import { FakeModelProvider } from "@/integrations/fake-model-provider";

/**
 * 本地 fixture provider（MODEL_PROTOCOL=fake / SEARCH_PROVIDER=fake）。
 * 数据全部是人工构造的合成示例（example.org），run 记录 integration_mode=fixture，UI 显示"示例数据"。
 * 不冒充真实模型或真实联网。
 */

const FIXTURE_PAGES = [
  {
    url: "https://example.org/fixture/small-classification-baseline",
    title: "（示例）小型分类基线练习",
    text:
      "这是一个合成示例页面。练习内容：选择一个公开的小型数据集，训练逻辑回归基线，" +
      "并整理错分样本。所需条件：会写基础 Python。整个练习可以在普通电脑上完成，不需要 GPU。",
  },
  {
    url: "https://example.org/fixture/gpu-finetune",
    title: "（示例）大模型微调实践",
    text:
      "这是一个合成示例页面。练习内容：微调一个中等规模的语言模型。" +
      "所需条件：需要至少一块 24GB 显存的 GPU，并且需要申请受限数据集的访问权限。",
  },
];

export function fixtureSearchProvider(): SearchProvider {
  return {
    provider: "fixture",
    async search({ query, maxResults }): Promise<SearchHit[]> {
      return FIXTURE_PAGES.slice(0, maxResults).map((p) => ({
        id: crypto.randomUUID(),
        title: p.title,
        url: p.url,
        snippet: `${p.text.slice(0, 60)}…（示例，检索词：${query.slice(0, 40)}）`,
        publishedAt: null,
      }));
    },
    async extract({ urls }): Promise<EvidenceDocument[]> {
      const at = new Date().toISOString();
      return urls
        .map((u) => FIXTURE_PAGES.find((p) => p.url === u))
        .filter((p): p is (typeof FIXTURE_PAGES)[number] => Boolean(p))
        .map((p) => ({ id: crypto.randomUUID(), url: p.url, text: p.text, status: "retrieved" as const, retrievedAt: at }));
    },
  };
}

type FixtureEvidence = { id: string; text: string };

/** 按证据文本构造候选：只引用真实存在的片段；GPU/受限数据标 unknown（F7） */
export function fixtureModelResponder(req: ModelRequest): ModelResult {
  if (req.workflow === MODEL_WORKFLOW_PLAN) {
    const ctx = req.context as { question?: string };
    return { ok: true, validatedResult: { queries: [String(ctx.question ?? "实践").slice(0, 200)] } };
  }
  if (req.workflow === MODEL_WORKFLOW_CANDIDATES) {
    const ctx = req.context as { evidence?: FixtureEvidence[] };
    const evidence = ctx.evidence ?? [];
    if (evidence.length === 0) {
      return { ok: true, validatedResult: { candidates: [], insufficientReason: "（示例）没有可引用的资料" } };
    }
    const candidates = evidence.slice(0, 3).map((e, i) => {
      const needsGpu = /需要[^。]*(GPU|显存)/.test(e.text) && !/不需要 ?GPU/.test(e.text);
      const quote = firstSentence(e.text);
      return {
        title: needsGpu ? "（示例）尝试一次模型微调" : `（示例）小型实践 ${i + 1}`,
        question: "这个方向的实际工作是什么样的？",
        activities: ["阅读资料并确定范围", "完成一次最小实践", "记录结果与感受"],
        deliverable: "一页实践记录",
        firstTask: { title: "阅读资料并写下要验证的问题", input: "证据页面", output: "3 条问题", estimateMinutes: 30 },
        initialTasks: [{ title: "完成最小实践", input: "", output: "运行记录", estimateMinutes: 90 }],
        estimatedMinutesRange: { min: 120, max: 360 },
        requirements: needsGpu
          ? [
              { label: "24GB 显存 GPU", status: "unknown", basis: "资料要求，主人条件未知" },
              { label: "受限数据集访问权限", status: "unknown", basis: "资料要求申请" },
            ]
          : [{ label: "基础 Python", status: "unknown", basis: "资料要求，待主人确认" }],
        unknowns: needsGpu ? ["是否有可用 GPU", "能否获得数据访问权限"] : [],
        fitReason: "（示例）与提出的问题相关",
        sourceRefs: [{ evidenceId: e.id, quote }],
      };
    });
    return { ok: true, validatedResult: { candidates, insufficientReason: null } };
  }
  if (req.workflow === MODEL_WORKFLOW_REVIEW) {
    // （示例）只引用 facts 里真实存在的 id；有卡点时对第一个未完成任务给一份提案
    const f = (req.context as { facts: { logs: Array<{ id: string; blocker: string; taskId: string | null }>; openTasks: Array<{ id: string; title: string; status: string }>; completedTasks: Array<{ id: string }> } }).facts;
    const firstLog = f.logs[0];
    const blockerLog = f.logs.find((l) => l.blocker);
    const target = f.openTasks.find((t) => t.id === blockerLog?.taskId) ?? f.openTasks[0];
    return {
      ok: true,
      validatedResult: {
        factNotes: firstLog ? [{ text: `（示例）本周有 ${f.logs.length} 条记录，完成 ${f.completedTasks.length} 项任务`, evidenceIds: [firstLog.id] }] : [],
        observations: blockerLog ? [{ text: "（示例）卡点可能来自任务范围过大", evidenceIds: [blockerLog.id] }] : [],
        proposals:
          blockerLog && target
            ? [
                {
                  reason: `（示例）把「${target.title}」拆出一个 30 分钟的小步骤`,
                  evidenceIds: [blockerLog.id],
                  operations: [{ kind: "create_task", title: `（示例）${target.title}：先做最小一步`, description: "", estimateMinutes: 30, projectId: null, week: "this" }],
                },
              ]
            : [],
        insufficientReason: null,
      },
    };
  }
  if (req.workflow === MODEL_WORKFLOW_BLOCKER) {
    const c = req.context as { selectedLog: { id: string; blocker: string; taskId: string | null } | null; logs: Array<{ id: string }>; tasks: Array<{ id: string; title: string; status: string }>; project: { id: string } | null };
    const log = c.selectedLog ?? (c.logs[0] as { id: string; blocker?: string; taskId?: string | null } | undefined);
    if (!log) return { ok: true, validatedResult: { explanations: [], nextSteps: [], followUpQuestion: null, proposal: null, insufficientReason: "（示例）没有记录" } };
    const task = c.tasks.find((t) => t.id === (log as { taskId?: string | null }).taskId) ?? c.tasks[0];
    return {
      ok: true,
      validatedResult: {
        explanations: [{ text: "（示例）可能是缺少一个可以立刻开始的具体步骤", evidenceIds: [log.id] }],
        nextSteps: ["（示例）写下卡住的那一步需要的输入，并用 15 分钟验证能否拿到"],
        followUpQuestion: null,
        proposal: task
          ? {
              reason: `（示例）为「${task.title}」加一个 30 分钟的最小步骤`,
              evidenceIds: [log.id, task.id],
              operations: [{ kind: "create_task", title: `（示例）${task.title}：最小一步`, description: "", estimateMinutes: 30, projectId: c.project?.id ?? null, week: "this" }],
            }
          : null,
        insufficientReason: null,
      },
    };
  }
  return { ok: false, error: { code: "PROTOCOL_UNSUPPORTED", message: `fixture 不支持 ${req.workflow}`, retryable: false } };
}

export function fixtureModelProvider(): ModelProvider {
  // fixture 同样经过 schema 校验，行为与真实 provider 一致
  const inner = new FakeModelProvider(fixtureModelResponder);
  return {
    protocol: "fake",
    async call(req) {
      const r = await inner.call(req);
      if (!r.ok) return r;
      const parsed = req.schema.safeParse(r.validatedResult);
      return parsed.success
        ? { ...r, validatedResult: parsed.data }
        : { ok: false, error: { code: "SCHEMA_INVALID", message: parsed.error.message, retryable: false } };
    },
  };
}

function firstSentence(text: string): string {
  const m = text.match(/[^。.!?！？]+[。.!?！？]/g);
  const pick = m?.find((s) => /所需|需要|练习内容/.test(s)) ?? m?.[0] ?? text;
  return pick.trim().slice(0, 300);
}
