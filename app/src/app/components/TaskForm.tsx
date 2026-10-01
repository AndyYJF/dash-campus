"use client";

import { useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { useDraft } from "./useDraft";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";

/**
 * 新建任务表单（今日/计划/项目页共用）。
 * 幂等键跟随草稿保存：超时或 401 后再点一次复用同一个键，服务端重放而不是再建一条；
 * 只有成功创建后才换新键。归属周只能选周一（input type=week 不通用，改为下拉最近 8 周）。
 */

type Draft = { title: string; estimate: string; dueDate: string; plannedMonday: string; key: string };

export default function TaskForm({
  projectId,
  defaultPlannedMonday,
  weekOptions,
  timezone,
  onCreated,
}: {
  projectId?: string;
  defaultPlannedMonday?: string | null;
  /** 可选的周一列表（实例时区）；不给则不显示归属周 */
  weekOptions?: string[];
  /** 实例时区；截止日期和归属周都按它解释，不用浏览器时区 */
  timezone?: string;
  onCreated: () => void;
}) {
  const { value: d, update, clear } = useDraft<Draft>(`task-form:${projectId ?? "general"}`, {
    title: "",
    estimate: "",
    dueDate: "",
    plannedMonday: defaultPlannedMonday ?? "",
    key: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function create() {
    if (!d.title.trim()) {
      setError({ message: "标题不能为空" });
      return;
    }
    const key = d.key || newIdempotencyKey();
    if (!d.key) update({ key });
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/tasks", {
        method: "POST",
        idempotencyKey: key,
        body: {
          title: d.title.trim(),
          description: "",
          projectId: projectId ?? null,
          goalId: null,
          estimateMinutes: d.estimate === "" ? null : Number(d.estimate),
          plannedWeek: d.plannedMonday ? { localMonday: d.plannedMonday, timezone: tz } : null,
          due: d.dueDate ? { kind: "date", localDate: d.dueDate, timezone: tz } : { kind: "none" },
        },
      });
      clear({ plannedMonday: d.plannedMonday });
      onCreated();
    } catch (e) {
      // 内容改动后再提交是新请求：清掉旧键，避免同键异体 409
      setError(toErrorState(e, "创建失败，内容已保留"));
    } finally {
      setBusy(false);
    }
  }

  // 用户改了内容 → 之前的幂等键作废
  const edit = (patch: Partial<Draft>) => update({ ...patch, key: "" });

  return (
    <div>
      <input
        className={styles.field}
        placeholder="新任务标题"
        aria-label="新任务标题"
        value={d.title}
        onChange={(e) => edit({ title: e.target.value })}
      />
      <div className={styles.fieldRow}>
        <input
          className={styles.field}
          type="number"
          min={0}
          placeholder="估时(分钟)"
          aria-label="估时（分钟）"
          value={d.estimate}
          onChange={(e) => edit({ estimate: e.target.value })}
        />
        <input
          className={styles.field}
          type="date"
          aria-label="截止日期"
          value={d.dueDate}
          onChange={(e) => edit({ dueDate: e.target.value })}
        />
        {weekOptions && weekOptions.length > 0 && (
          <select
            className={styles.field}
            aria-label="归属周"
            value={d.plannedMonday}
            onChange={(e) => edit({ plannedMonday: e.target.value })}
          >
            <option value="">不指定周</option>
            {weekOptions.map((m) => (
              <option key={m} value={m}>
                {m} 起的一周
              </option>
            ))}
          </select>
        )}
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={create} disabled={busy}>
          {busy ? "创建中…" : "添加任务"}
        </button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

/** 从某个周一开始的连续 n 个周一 */
export function mondaysFrom(localMonday: string, n = 8): string[] {
  const out: string[] = [];
  const d = new Date(`${localMonday}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
