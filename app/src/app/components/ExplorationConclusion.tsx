"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";

/**
 * 项目的探索结束判断（7.3）：只记录本次主人结论；更新关注方向需要另一个明确操作；
 * 没有结束反馈时显示"探索结论未填写"，不生成职业适配分数。
 */

type Exploration = {
  candidateId: string | null;
  startInclination: "unknown" | "interested" | "unsure" | null;
  experiencedActivities: string | null;
  conclusion: "continue" | "change" | "undecided" | null;
  conclusionReason: string | null;
  conclusionArtifactIds: string[];
  concludedAt: string | null;
};

const INCLINATION = { unknown: "还不知道", interested: "有兴趣", unsure: "不确定" } as const;
const CONCLUSION = { continue: "继续这个方向", change: "换方向", undecided: "未定" } as const;

export default function ExplorationConclusion({
  projectId,
  projectVersion,
  projectStatus,
  artifacts,
  onSaved,
}: {
  projectId: string;
  projectVersion: number;
  projectStatus: string;
  artifacts: Array<{ id: string; title: string }>;
  onSaved: () => void;
}) {
  const [data, setData] = useState<Exploration | null>(null);
  const [editing, setEditing] = useState(false);
  const [activities, setActivities] = useState("");
  const [conclusion, setConclusion] = useState<keyof typeof CONCLUSION>("undecided");
  const [reason, setReason] = useState("");
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api<{ exploration: Exploration }>(`/api/v1/projects/${projectId}/conclusion`)
      .then((r) => {
        setData(r.exploration);
        setActivities(r.exploration.experiencedActivities ?? "");
        setConclusion(r.exploration.conclusion ?? "undecided");
        setReason(r.exploration.conclusionReason ?? "");
        setArtifactIds(r.exploration.conclusionArtifactIds);
      })
      .catch(() => {});
  }, [projectId]);
  useEffect(refresh, [refresh]);

  if (!data) return null;
  // 只有来自候选或已填过结论的项目显示此区块
  if (!data.candidateId && !data.conclusion) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/projects/${projectId}/conclusion`, {
        method: "POST",
        body: { expectedVersion: projectVersion, experiencedActivities: activities, conclusion, reason, artifactIds },
      });
      setEditing(false);
      refresh();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "项目已在别处修改，请刷新后重试（输入已保留）" : err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      <h2>探索结论</h2>
      <p className={styles.muted}>
        开始倾向：{data.startInclination ? INCLINATION[data.startInclination] : "未记录"}
        {data.candidateId && " · 来自探索候选"}
      </p>
      {!editing && (
        <>
          {data.conclusion ? (
            <>
              <p>
                <strong>{CONCLUSION[data.conclusion]}</strong>
                {data.concludedAt && <span className={styles.muted}> · {new Date(data.concludedAt).toLocaleDateString("zh-CN")}</span>}
              </p>
              {data.experiencedActivities && <p>实际做了：{data.experiencedActivities}</p>}
              {data.conclusionReason && <p>理由：{data.conclusionReason}</p>}
              {data.conclusionArtifactIds.length > 0 && (
                <p className={styles.muted}>
                  引用成果：{data.conclusionArtifactIds.map((id) => artifacts.find((a) => a.id === id)?.title ?? "（已删除）").join("、")}
                </p>
              )}
              <p className={styles.muted}>这里只记录你本次的判断，不会自动修改关注方向。</p>
            </>
          ) : (
            <p className={styles.muted}>
              {projectStatus === "completed" ? "项目已完成，探索结论未填写。" : "探索结论未填写。"}
            </p>
          )}
          <button className={styles.btn} onClick={() => setEditing(true)}>
            {data.conclusion ? "修改结论" : "填写结论"}
          </button>
          {" "}
          <Link href="/explore" className={styles.muted}>
            去探索页调整关注方向
          </Link>
        </>
      )}
      {editing && (
        <form onSubmit={save}>
          <label className={ex.fieldLabel}>
            实际体验的活动
            <textarea className={styles.field} rows={2} value={activities} onChange={(e) => setActivities(e.target.value)} />
          </label>
          <label className={ex.fieldLabel}>
            你的判断
            <select className={styles.field} value={conclusion} onChange={(e) => setConclusion(e.target.value as keyof typeof CONCLUSION)}>
              {Object.entries(CONCLUSION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className={ex.fieldLabel}>
            理由
            <textarea className={styles.field} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {artifacts.length > 0 && (
            <fieldset style={{ border: "none", padding: 0 }}>
              <legend className={ex.fieldLabel}>引用成果</legend>
              {artifacts.map((a) => (
                <label key={a.id} className={ex.inlineLabel}>
                  <input
                    type="checkbox"
                    checked={artifactIds.includes(a.id)}
                    onChange={(e) => setArtifactIds(e.target.checked ? [...artifactIds, a.id] : artifactIds.filter((x) => x !== a.id))}
                  />
                  {a.title}
                </label>
              ))}
            </fieldset>
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={ex.row}>
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存结论"}
            </button>
            <button className={styles.btn} type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
