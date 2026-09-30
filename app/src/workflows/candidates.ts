import { z } from "zod";
import { getDb } from "@/repositories/db";
import { createProject, createTask, getProject } from "@/repositories/planning";
import { getCandidate, updateCandidateRow, type CandidateRow } from "@/repositories/exploration";
import type { createProjectFromCandidateSchema, projectConclusionSchema } from "@/contracts/exploration";

/**
 * 候选 → 独立项目（计划 v1.2 第 4.1、7.1、7.3 节）。
 * - 必须创建新项目对象，不复用现有项目标题（产品计划 5）。
 * - "可以开始"仅在关键条件经主人确认具备时成立；否则需显式"带这些未知条件开始"并记录选择。
 * - 初始任务最多 5 个，由主人编辑后提交。
 */

type CreateInput = z.infer<typeof createProjectFromCandidateSchema>;

export type CreateProjectResult =
  | { kind: "created"; projectId: string; taskIds: string[]; startedWithUnknowns: boolean }
  | { kind: "exists"; projectId: string }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "unknowns_not_accepted"; pending: string[] };

/** 候选是否"可以开始"：所有条件都经主人确认具备 */
export function readyToStart(c: CandidateRow): boolean {
  return c.requirements.every((r) => r.status === "met" && r.confirmedByOwner) && c.evidenceStatus !== "snippet";
}

export function createProjectFromCandidate(candidateId: string, input: CreateInput): CreateProjectResult {
  const db = getDb();
  const tx = db.transaction((): CreateProjectResult => {
    const c = getCandidate(candidateId);
    if (!c) return { kind: "not_found" };
    // 已建过项目：返回既有（重复点击不建第二个）
    if (c.projectId) return { kind: "exists", projectId: c.projectId };
    if (c.version !== input.expectedVersion) return { kind: "conflict" };

    const confirmed = new Set(input.confirmedRequirementIndexes);
    const requirements = c.requirements.map((r, i) =>
      confirmed.has(i) ? { ...r, status: "met" as const, confirmedByOwner: true } : r,
    );
    const pending = [
      ...requirements.filter((r) => !(r.status === "met" && r.confirmedByOwner)).map((r) => `${r.label}（${r.status === "unmet" ? "未满足" : "未知"}）`),
      ...(c.evidenceStatus === "snippet" ? ["来源只有摘要，原文未取得"] : []),
    ];
    const withUnknowns = pending.length > 0;
    if (withUnknowns && !input.acceptUnknowns) return { kind: "unknowns_not_accepted", pending };

    const project = createProject({
      title: input.title,
      question: input.question,
      expectedOutcome: input.expectedOutcome,
      prerequisites: input.prerequisites,
      reviewQuestions: input.reviewQuestions,
      goalIds: input.goalIds,
    });
    db.prepare(`UPDATE projects SET candidate_id = ?, start_inclination = ? WHERE id = ?`).run(
      c.id,
      input.startInclination,
      project.id,
    );
    const taskIds: string[] = [];
    for (const t of input.tasks.slice(0, 5)) {
      const task = createTask({
        title: t.title,
        description: t.description,
        projectId: project.id,
        goalId: null,
        status: "todo",
        priority: "normal",
        estimateMinutes: t.estimateMinutes,
        plannedWeek: null,
        scheduledStart: null,
        scheduledEnd: null,
        due: { kind: "none" },
      });
      taskIds.push(task.id);
    }
    const updated = updateCandidateRow(c.id, c.version, {
      status: "started",
      projectId: project.id,
      startedWithUnknowns: withUnknowns,
      requirements,
    });
    if (!updated) throw new Error("CANDIDATE_VERSION_RACE");
    return { kind: "created", projectId: project.id, taskIds, startedWithUnknowns: withUnknowns };
  });
  try {
    return tx.immediate();
  } catch (e) {
    if (e instanceof Error && e.message === "CANDIDATE_VERSION_RACE") return { kind: "conflict" };
    throw e;
  }
}

// ===== 探索结束判断（7.3） =====

export type ProjectExploration = {
  candidateId: string | null;
  startInclination: "unknown" | "interested" | "unsure" | null;
  experiencedActivities: string | null;
  conclusion: "continue" | "change" | "undecided" | null;
  conclusionReason: string | null;
  conclusionArtifactIds: string[];
  concludedAt: string | null;
};

export function getProjectExploration(projectId: string): ProjectExploration | null {
  const r = getDb()
    .prepare(
      `SELECT candidate_id, start_inclination, experienced_activities, conclusion, conclusion_reason,
              conclusion_artifact_ids_json, concluded_at FROM projects WHERE id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    candidateId: (r.candidate_id as string | null) ?? null,
    startInclination: (r.start_inclination as ProjectExploration["startInclination"]) ?? null,
    experiencedActivities: (r.experienced_activities as string | null) ?? null,
    conclusion: (r.conclusion as ProjectExploration["conclusion"]) ?? null,
    conclusionReason: (r.conclusion_reason as string | null) ?? null,
    conclusionArtifactIds: r.conclusion_artifact_ids_json ? JSON.parse(r.conclusion_artifact_ids_json as string) : [],
    concludedAt: (r.concluded_at as string | null) ?? null,
  };
}

/** 只记录本次主人结论；不改关注方向、不生成适配分数（7.3） */
export function saveProjectConclusion(
  projectId: string,
  input: z.infer<typeof projectConclusionSchema>,
): "ok" | "not_found" | "conflict" | "bad_artifact" {
  const db = getDb();
  const tx = db.transaction(() => {
    const p = getProject(projectId);
    if (!p || p.archivedAt) return "not_found" as const;
    for (const aid of input.artifactIds) {
      const a = db.prepare(`SELECT project_id FROM artifacts WHERE id = ?`).get(aid) as { project_id: string } | undefined;
      if (!a || a.project_id !== projectId) return "bad_artifact" as const;
    }
    const t = new Date().toISOString();
    const r = db
      .prepare(
        `UPDATE projects SET experienced_activities = ?, conclusion = ?, conclusion_reason = ?,
           conclusion_artifact_ids_json = ?, concluded_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        input.experiencedActivities,
        input.conclusion,
        input.reason,
        JSON.stringify(input.artifactIds),
        t,
        t,
        projectId,
        input.expectedVersion,
      );
    return r.changes === 1 ? ("ok" as const) : ("conflict" as const);
  });
  return tx();
}
