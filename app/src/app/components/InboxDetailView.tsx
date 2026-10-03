"use client";

const TASK_STATUS_LABEL: Record<string, string> = { todo: "待办", doing: "进行中", blocked: "卡住", done: "已完成", cancelled: "已取消" };

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import { PROFILE_FIELDS } from "@/contracts/inbox";

/**
 * 收件箱详情（T4）：原文与条件引用、三种纠正作用域（默认仅本条）、
 * 修订历史与冲突选择、行动草案创建任务与来源变化差异。
 */

type Detail = {
  extraction: null | {integrationMode: string; status: string; error: string | null; evidence: string | null};
  message: { id: string; status: "active" | "revision_conflict"; externalId: string; sourceId: string };
  current: {
    id: string;
    text: string;
    sourceUrl: string | null;
    occurredAt: string;
    structured: {
      noticeType: string;
      condition?: { kind: string; field?: string; op?: string; value?: unknown; quote?: string; children?: unknown[] };
      action?: { actionKey: string; title: string; description: string; required: boolean };
    } | null;
  } | null;
  decision: {
    version: number;
    applicability: string | null;
    partition: string;
    basePartition: string;
    manualPartition: string | null;
    matchedRuleId: string | null;
  } | null;
  revisions: Array<{ id: string; revisionKey: string; revisionOrder: number | null; occurredAt: string; isCurrent: boolean }>;
  links: Array<{ actionKey: string; taskId: string; task: { title: string; status: string } | null }>;
  sourceChanges: Array<{
    actionKey: string;
    taskId: string;
    changed: boolean;
    fields: Array<{ field: string; taskValue: string; draftValue: string }>;
  }>;
};

const PARTITIONS = ["action", "info", "opportunity", "review", "folded"] as const;
const PARTITION_LABEL: Record<string, string> = {
  action: "需要行动",
  info: "信息",
  opportunity: "自愿参加",
  review: "待确认",
  folded: "不参加/折叠",
};

type Fact = { field: string; value: string; version: number };

export default function InboxDetailView() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [partition, setPartition] = useState<string>("folded");
  const [factField, setFactField] = useState("education_level");
  const [factValue, setFactValue] = useState("");
  const [rulePartition, setRulePartition] = useState("folded");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api<Detail>(`/api/v1/inbox/${params.id}`)
      .then(setDetail)
      .catch((e) => setMessage(e instanceof Error ? e.message : "加载失败"));
    api<{ facts: Fact[] }>("/api/v1/profile").then((r) => setFacts(r.facts)).catch(() => {});
  }, [params.id]);

  useEffect(refresh, [refresh]);
  const extractionStatus = detail?.extraction?.status;
  useEffect(() => {
    if (!extractionStatus || !["queued", "running"].includes(extractionStatus)) return;
    const timer = setInterval(refresh, 3000); return () => clearInterval(timer);
  }, [extractionStatus, refresh]);

  async function post(path: string, body: unknown, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api(path, { method: "POST", body });
      setMessage(ok);
      refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <p className={styles.muted}>{message ?? "加载中…"}</p>;
  const { current, decision, message: msg } = detail;
  const condition = current?.structured?.condition;
  const action = current?.structured?.action;
  const factVersion = facts.find((f) => f.field === factField)?.version ?? 0;

  return (
    <div className={styles.narrow}>
      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>通知原文</h2>
        {detail.extraction && <div className={styles.notice}><p>{detail.extraction.integrationMode === "fixture" ? "（示例数据，非真实模型）" : ""}条件与行动提取：{{queued: "排队中", running: "提取中", done: "已完成", failed: "未完成", superseded: "旧版本已跳过"}[detail.extraction.status] ?? detail.extraction.status}</p>{detail.extraction.error && <p>{detail.extraction.error}</p>}{detail.extraction.evidence && <ExtractionEvidence raw={detail.extraction.evidence} />}</div>}
        {current && !["queued", "running"].includes(detail.extraction?.status ?? "") && <button className={styles.btn} disabled={busy} onClick={() => void post(`/api/v1/inbox/${params.id}/extract`, {revisionId: current.id}, "已排队重新提取；人工分区覆盖会保留。")}>重新提取原文</button>}
        <p style={{ whiteSpace: "pre-wrap" }}>{current?.text ?? "（无当前版本）"}</p>
        {current?.sourceUrl && (
          <p>
            <a href={current.sourceUrl} target="_blank" rel="noreferrer">
              原文链接
            </a>
          </p>
        )}
        <p className={styles.muted}>
          来源 {msg.sourceId} / 外部 ID {msg.externalId} / 通知类型{" "}
          {current?.structured?.noticeType ?? "（未提取）"}
        </p>
      </div>

      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>判定与分区</h2>
        <dl className={styles.facts}>
          <dt>资格判定</dt>
          <dd>
            {decision?.applicability === "TRUE" && <span className={`${styles.badge} ${styles.badgeOk}`}>符合</span>}
            {decision?.applicability === "FALSE" && <span className={styles.badge}>不符合</span>}
            {decision?.applicability === "UNKNOWN" && (
              <>
                <span className={`${styles.badge} ${styles.badgeHigh}`}>条件未知</span>{" "}
                <span className={styles.muted}>不据标题猜资格</span>
              </>
            )}
            {!decision?.applicability && <span className={styles.badge}>未筛选（资格条件待确认）</span>}
          </dd>
          <dt>分区</dt>
          <dd>
            {PARTITION_LABEL[decision?.partition ?? ""] ?? decision?.partition}
            {decision?.manualPartition && "（人工覆盖）"}
            {decision?.matchedRuleId && "（人工规则）"}
          </dd>
        </dl>
        {condition && (
          <div className={styles.muted}>
            条件依据：
            {condition.field} {condition.op}{" "}
            {Array.isArray(condition.value) ? condition.value.join(" / ") : String(condition.value ?? "")}
            {condition.quote && ` —— 原文引用：「${condition.quote}」`}
          </div>
        )}
      </div>

      {!action && detail.links.length > 0 && <div className={styles.card}>
        <h2 className={styles.sectionTitle}>已关联任务</h2>
        {detail.links.map((link) => <div key={link.actionKey} className={styles.logItem}>
          {link.task?.title ?? "任务不可用"} · {TASK_STATUS_LABEL[link.task?.status ?? ""] ?? "未知状态"}
          {detail.sourceChanges.some((c) => c.taskId === link.taskId && c.changed) && <p className={styles.muted}>来源与任务有差异，请核对原文与上游状态；任务保持你的修改。</p>}
        </div>)}
      </div>}
      {action && (
        <div className={styles.card}>
          <h2 className={styles.sectionTitle}>行动草案：{action.title}</h2>
          {detail.links.some((l) => l.actionKey === action.actionKey) ? (
            <>
              <p className={styles.muted}>
                已创建任务：
                {detail.links.find((l) => l.actionKey === action.actionKey)?.task?.title}
              </p>
              {detail.sourceChanges
                .filter((c) => c.changed)
                .map((c) => (
                  <div key={c.actionKey} className={styles.logItem}>
                    来源与任务有差异（只标记，不覆盖你的任务）：
                    {c.fields.map((f) => (
                      <div key={f.field}>
                        {f.field === "title" ? "标题" : "截止"}：你的「{f.taskValue}」 vs 来源「
                        {f.draftValue}」
                      </div>
                    ))}
                  </div>
                ))}
            </>
          ) : (
            <div>
              <p className={styles.muted}>
                {action.required ? "需提交" : "自愿参与"} · actionKey {action.actionKey}
              </p>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy}
                onClick={() =>
                  post(
                    `/api/v1/inbox/${msg.id}/create-task`,
                    { actionKey: action.actionKey },
                    "已创建任务（可在计划中编辑）",
                  )
                }
              >
                创建为任务（不会重复创建）
              </button>
            </div>
          )}
        </div>
      )}

      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>纠正（默认：仅本条）</h2>
        <div className={ex.row}>
          <select aria-label="本条改放到的分区" value={partition} onChange={(e) => setPartition(e.target.value)}>
            {PARTITIONS.map((p) => (
              <option key={p} value={p}>
                {PARTITION_LABEL[p]}
              </option>
            ))}
          </select>
          <button
            className={styles.btn}
            disabled={busy}
            onClick={() =>
              post(
                `/api/v1/inbox/${msg.id}/resolve`,
                { scope: "this_revision", partition, revisionId: current?.id, expectedVersion: decision?.version },
                "已覆盖本条分区（不影响身份和其他通知）",
              )
            }
          >
            仅本条
          </button>
        </div>
        <div className={ex.row} style={{ marginTop: 8 }}>
          <select aria-label="要更正的身份字段" value={factField} onChange={(e) => setFactField(e.target.value)}>
            {PROFILE_FIELDS.map((field) => <option key={field} value={field}>{{education_level: "学历层次", program: "专业", campus: "校区", grade_year: "入学年份", study_year: "当前年级"}[field]}</option>)}
          </select>
          <input
            aria-label="更正后的身份值"
            placeholder="更正后的身份值"
            value={factValue}
            onChange={(e) => setFactValue(e.target.value)}
          />
          <button
            className={styles.btn}
            disabled={busy || factValue.trim() === ""}
            onClick={() =>
              post(
                `/api/v1/inbox/${msg.id}/resolve`,
                {
                  scope: "profile",
                  facts: [{ field: factField, value: factValue, expectedVersion: factVersion }],
                },
                "已更正身份并重评受影响通知",
              )
            }
          >
            更正身份
          </button>
        </div>
        <div className={ex.row} style={{ marginTop: 8 }}>
          <select aria-label="同类通知改放到的分区" value={rulePartition} onChange={(e) => setRulePartition(e.target.value)}>
            {PARTITIONS.map((p) => (
              <option key={p} value={p}>
                {PARTITION_LABEL[p]}
              </option>
            ))}
          </select>
          <button
            className={styles.btn}
            disabled={busy || !condition}
            onClick={() =>
              post(
                `/api/v1/inbox/${msg.id}/resolve`,
                {
                  scope: "rule",
                  rule: {
                    source: msg.sourceId,
                    noticeType: current?.structured?.noticeType ?? "",
                    condition,
                    outputPartition: rulePartition,
                    priority: 1,
                  },
                },
                "已保存并启用规则（可停用/删除）",
              )
            }
          >
            保存为规则（作用于同类通知）
          </button>
        </div>
        <p className={styles.muted}>注意：“资格不符”不能只来自个人偏好；不想参加用“仅本条”。</p>
      </div>

      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>修订历史</h2>
        {detail.revisions.map((r) => (
          <div key={r.id} className={styles.taskRow}>
            <span className={styles.taskTitle}>
              {r.revisionKey}
              <span className={styles.taskMeta}>
                {r.isCurrent ? " · 当前" : ""}
                {r.revisionOrder === null ? " · 顺序未知" : ` · 顺序 ${r.revisionOrder}`}
              </span>
            </span>
            {msg.status === "revision_conflict" && (
              <button
                className={styles.btn}
                disabled={busy || r.isCurrent}
                onClick={() =>
                  post(`/api/v1/inbox/${msg.id}/select-revision`, { revisionId: r.id }, "已选择当前版本")
                }
              >
                {r.isCurrent ? "当前" : "选为当前"}
              </button>
            )}
          </div>
        ))}
      </div>

      {message && (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}
    </div>
  );
}


function ExtractionEvidence({raw}: {raw: string}) {
  let e: {actionQuote: string | null; dueQuote: string | null; unknownReason: string | null};
  try { e = JSON.parse(raw); } catch { return null; }
  return <div>{e.actionQuote && <p>行动依据：{e.actionQuote}</p>}{e.dueQuote && <p>截止依据：{e.dueQuote}</p>}{e.unknownReason && <p>仍不确定：{e.unknownReason}</p>}</div>;
}
