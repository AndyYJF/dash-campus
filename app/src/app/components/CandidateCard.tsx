"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";

/**
 * CandidateCard（13.1）：问题、活动、条件、产出、材料、投入；来源取回状态与条件确认状态分开。
 * 不负责：自动宣称用户适合某方向。
 * 开始项目：主人编辑草案（标题/问题/产出/最多 5 个任务），确认已具备的条件；
 * 仍有未知时必须勾选"带这些未知条件开始"。
 */

export type EvidenceMeta = {
  id: string;
  url: string | null;
  title: string;
  status: "snippet" | "retrieved" | "user_supplied";
  retrievedAt: string;
  publishedAt: string | null;
};

type Task = { title: string; input: string; output: string; estimateMinutes: number | null };

export type Candidate = {
  id: string;
  title: string;
  question: string;
  activities: string[];
  deliverable: string;
  firstTask: Task;
  initialTasks: Task[];
  estimatedMinutesRange: { min: number; max: number } | null;
  requirements: Array<{ label: string; status: "met" | "unmet" | "unknown"; basis: string; confirmedByOwner: boolean }>;
  unknowns: string[];
  fitReason: string;
  sourceRefs: Array<{ evidenceId: string; quote: string }>;
  evidenceStatus: "snippet" | "retrieved" | "user_supplied";
  supersedesId: string | null;
  status: "proposed" | "idea" | "started" | "dismissed";
  feedback: string | null;
  projectId: string | null;
  startedWithUnknowns: boolean;
  readyToStart: boolean;
  version: number;
};

const REQ_LABEL = { met: "已确认具备", unmet: "未满足", unknown: "未知" } as const;
const FEEDBACK = [
  ["not_interested", "方向不感兴趣"],
  ["lacking_basics", "现在基础不够"],
  ["no_time", "暂时没时间"],
  ["low_quality", "内容质量差"],
] as const;

function hours(r: { min: number; max: number } | null): string {
  if (!r) return "投入未知";
  const h = (m: number) => (m < 60 ? `${m} 分钟` : `${Math.round((m / 60) * 10) / 10} 小时`);
  return `约 ${h(r.min)}–${h(r.max)}`;
}

function describe(t: Task): string {
  return [t.input && `输入：${t.input}`, t.output && `产出：${t.output}`].filter(Boolean).join("；");
}

export default function CandidateCard({
  candidate: c,
  evidenceById,
  onChange,
}: {
  candidate: Candidate;
  evidenceById: Map<string, EvidenceMeta>;
  onChange: () => void;
}) {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  async function act(action: "save_idea" | "dismiss", feedback: string | null = null) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/candidates/${c.id}`, { method: "PATCH", body: { expectedVersion: c.version, action, feedback } });
      onChange();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "候选已变化，已刷新" : e instanceof Error ? e.message : "操作失败");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={ex.candidate} aria-labelledby={`c-${c.id}`}>
      <h3 id={`c-${c.id}`}>{c.title}</h3>
      {c.supersedesId && <span className={styles.badge}>内容有更新</span>}

      <div>
        <span className={ex.fieldLabel}>要回答的问题</span>
        {c.question}
      </div>
      <div>
        <span className={ex.fieldLabel}>实际活动</span>
        <ul className={ex.list}>
          {c.activities.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </div>
      <div>
        <span className={ex.fieldLabel}>前置条件与资源</span>
        {c.requirements.length === 0 && <span className={styles.muted}>资料未提及</span>}
        {c.requirements.map((r, i) => (
          <div key={i} className={ex.req}>
            <span className={`${ex.status} ${ex[r.status]}`}>{REQ_LABEL[r.status]}</span>
            <span>
              {r.label}
              {r.basis && <span className={styles.muted}> · {r.basis}</span>}
            </span>
          </div>
        ))}
      </div>
      <div>
        <span className={ex.fieldLabel}>产出 · 投入</span>
        {c.deliverable} · {hours(c.estimatedMinutesRange)}
      </div>
      <div>
        <span className={ex.fieldLabel}>第一步</span>
        {c.firstTask.title}
        {describe(c.firstTask) && <div className={styles.muted}>{describe(c.firstTask)}</div>}
      </div>
      {c.unknowns.length > 0 && (
        <div>
          <span className={ex.fieldLabel}>信息缺口</span>
          <ul className={ex.list}>
            {c.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {c.fitReason && (
        <div className={styles.muted}>
          <span className={ex.fieldLabel}>与问题的关联</span>
          {c.fitReason}
        </div>
      )}
      <div>
        <span className={ex.fieldLabel}>出处（{c.evidenceStatus === "snippet" ? "仅摘要，待核实" : "原文片段已校验存在"}）</span>
        {c.sourceRefs.map((r, i) => {
          const e = evidenceById.get(r.evidenceId);
          return (
            <div key={i} style={{ marginBottom: 6 }}>
              <blockquote className={ex.quote}>{r.quote}</blockquote>
              {e &&
                (e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}>
                    {e.title || e.url}
                  </a>
                ) : (
                  <span className={styles.muted}>{e.title}</span>
                ))}
            </div>
          );
        })}
      </div>

      <div className={ex.actions}>
        {c.status === "started" && c.projectId ? (
          <Link href={`/projects/${c.projectId}`}>
            已开始 → 查看项目{c.startedWithUnknowns ? "（带未知条件）" : ""}
          </Link>
        ) : c.status === "dismissed" ? (
          <span className={styles.muted}>已不采纳{c.feedback ? `（${FEEDBACK.find((f) => f[0] === c.feedback)?.[1]}）` : ""}</span>
        ) : (
          <>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setDrafting((d) => !d)} disabled={busy}>
              {c.readyToStart ? "编辑草案并开始" : "编辑草案…"}
            </button>
            {c.status !== "idea" ? (
              <button className={styles.btn} onClick={() => act("save_idea")} disabled={busy}>
                保存为想法
              </button>
            ) : (
              <span className={styles.badge}>已保存为想法</span>
            )}
            <button className={styles.btn} onClick={() => setShowFeedback((s) => !s)} disabled={busy}>
              不采纳…
            </button>
          </>
        )}
      </div>
      {showFeedback && c.status !== "dismissed" && c.status !== "started" && (
        <div className={ex.row}>
          {FEEDBACK.map(([k, label]) => (
            <button key={k} className={styles.btn} onClick={() => act("dismiss", k)} disabled={busy}>
              {label}
            </button>
          ))}
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {drafting && c.status !== "started" && <ProjectDraft candidate={c} onDone={onChange} />}
    </article>
  );
}

function ProjectDraft({ candidate: c, onDone }: { candidate: Candidate; onDone: () => void }) {
  const initialTasks = [c.firstTask, ...c.initialTasks].slice(0, 5).map((t) => ({
    title: t.title,
    description: describe(t),
    estimateMinutes: t.estimateMinutes,
  }));
  const [title, setTitle] = useState(c.title.replace(/^（示例）/, ""));
  const [question, setQuestion] = useState(c.question);
  const [outcome, setOutcome] = useState(c.deliverable);
  const [inclination, setInclination] = useState<"unknown" | "interested" | "unsure">("unknown");
  const [tasks, setTasks] = useState(initialTasks);
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [acceptUnknowns, setAcceptUnknowns] = useState(false);
  const [key] = useState(() => newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const pending =c.requirements.filter((_, i) => !confirmed.includes(i));
  const needsAccept = pending.length > 0 || c.evidenceStatus === "snippet";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ projectId: string }>(`/api/v1/candidates/${c.id}/create-project`, {
        method: "POST",
        idempotencyKey: key,
        body: {
          expectedVersion: c.version,
          title: title.trim(),
          question,
          expectedOutcome: outcome,
          prerequisites: c.requirements.map((r) => r.label).join("；"),
          reviewQuestions: "",
          goalIds: [],
          startInclination: inclination,
          acceptUnknowns,
          confirmedRequirementIndexes: confirmed,
          tasks: tasks.filter((t) => t.title.trim()),
        },
      });
      router.push(`/projects/${r.projectId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败，草案已保留");
      if (err instanceof ApiError && err.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={ex.draft} onSubmit={submit}>
      <strong>项目草案（创建为新的独立项目）</strong>
      <label className={ex.fieldLabel}>
        项目标题
        <input className={styles.field} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className={ex.fieldLabel}>
        想验证的问题
        <textarea className={styles.field} rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label className={ex.fieldLabel}>
        预期产出
        <input className={styles.field} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </label>
      <label className={ex.fieldLabel}>
        开始时的倾向
        <select className={styles.field} value={inclination} onChange={(e) => setInclination(e.target.value as typeof inclination)}>
          <option value="unknown">还不知道</option>
          <option value="interested">有兴趣</option>
          <option value="unsure">不确定</option>
        </select>
      </label>

      <span className={ex.fieldLabel}>初始任务（最多 5 个，可改）</span>
      {tasks.map((t, i) => (
        <div key={i} className={ex.row} style={{ alignItems: "flex-start" }}>
          <input
            aria-label={`任务 ${i + 1}`}
            className={styles.field}
            style={{ flex: 2 }}
            value={t.title}
            onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
          />
          <input
            aria-label={`任务 ${i + 1} 估时（分钟）`}
            className={styles.field}
            style={{ flex: 1 }}
            type="number"
            min={0}
            placeholder="分钟"
            value={t.estimateMinutes ?? ""}
            onChange={(e) =>
              setTasks(tasks.map((x, j) => (j === i ? { ...x, estimateMinutes: e.target.value ? Number(e.target.value) : null } : x)))
            }
          />
          <button type="button" className={styles.btn} aria-label={`删除任务 ${i + 1}`} onClick={() => setTasks(tasks.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      {tasks.length < 5 && (
        <button type="button" className={styles.btn} onClick={() => setTasks([...tasks, { title: "", description: "", estimateMinutes: null }])}>
          + 添加任务
        </button>
      )}

      {c.requirements.length > 0 && (
        <fieldset style={{ border: "none", padding: 0, marginTop: 12 }}>
          <legend className={ex.fieldLabel}>勾选你确认已具备的条件</legend>
          {c.requirements.map((r, i) => (
            <label key={i} className={ex.inlineLabel}>
              <input
                type="checkbox"
                checked={confirmed.includes(i)}
                onChange={(e) => setConfirmed(e.target.checked ? [...confirmed, i] : confirmed.filter((x) => x !== i))}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
      )}
      {needsAccept && (
        <label className={ex.inlineLabel}>
          <input type="checkbox" checked={acceptUnknowns} onChange={(e) => setAcceptUnknowns(e.target.checked)} />
          带这些未知条件开始
          {c.evidenceStatus === "snippet" ? "（含：来源只有摘要）" : ""}
        </label>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button
        className={`${styles.btn} ${styles.btnPrimary}`}
        type="submit"
        disabled={busy || !title.trim() || tasks.filter((t) => t.title.trim()).length === 0 || (needsAccept && !acceptUnknowns)}
      >
        {busy ? "创建中…" : needsAccept ? "带未知条件开始" : "可以开始：创建项目"}
      </button>
    </form>
  );
}
