"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";

/**
 * 关注方向（定期探索订阅开关，T5）：每个方向独立开启、选择每周本地时间；
 * "立即运行一次"与定期同一工作流，明确标为手动触发。
 */

type Topic = {
  id: string;
  title: string;
  purpose: string;
  enabled: boolean;
  weekday: number;
  localTime: string;
  timezone: string;
  nextRunAt: string | null;
  version: number;
};

const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function TopicList({ searchReady, onRun }: { searchReady: boolean; onRun: () => void }) {
  const router = useRouter();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(() => newIdempotencyKey());

  const refresh = useCallback(() => {
    api<{ topics: Topic[] }>("/api/v1/exploration-topics")
      .then((r) => setTopics(r.topics))
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending("create");
    try {
      await api("/api/v1/exploration-topics", {
        method: "POST",
        body: { title: title.trim(), purpose, enabled: false },
        idempotencyKey: createKey,
      });
      setTitle("");
      setPurpose("");
      setCreateKey(newIdempotencyKey());
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败，输入已保留");
    } finally {
      setPending(null);
    }
  }

  async function patch(t: Topic, fields: Partial<Pick<Topic, "enabled" | "weekday" | "localTime">>) {
    setError(null);
    setPending(t.id);
    try {
      await api(`/api/v1/exploration-topics/${t.id}`, { method: "PATCH", body: { expectedVersion: t.version, ...fields } });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "已在别处修改，已刷新，请重试" : err instanceof Error ? err.message : "保存失败");
      refresh();
    } finally {
      setPending(null);
    }
  }

  async function runNow(t: Topic) {
    setError(null);
    setPending(t.id);
    try {
      const r = await api<{ runId: string }>(`/api/v1/exploration-topics/${t.id}/run`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
      });
      onRun();
      router.push(`/explore/${r.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动失败");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={styles.card}>
      <h2>关注方向</h2>
      <p className={styles.muted}>开启后每周按选定时间检索一次，最多 3 个新候选；证据相同的候选不重复提醒。</p>
      {topics.length === 0 && <p className={styles.empty}>还没有关注方向。</p>}
      {topics.map((t) => (
        <div key={t.id} className={styles.logItem}>
          <div className={ex.row}>
            <strong style={{ flex: 1 }}>{t.title}</strong>
            <label className={ex.inlineLabel} style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={t.enabled}
                disabled={pending === t.id}
                onChange={(e) => patch(t, { enabled: e.target.checked })}
              />
              定期
            </label>
          </div>
          {t.purpose && <div className={styles.muted}>{t.purpose}</div>}
          <div className={ex.row}>
            <select
              aria-label="每周哪天"
              className={styles.field}
              style={{ width: "auto", marginBottom: 0 }}
              value={t.weekday}
              disabled={pending === t.id}
              onChange={(e) => patch(t, { weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.slice(1).map((w, i) => (
                <option key={w} value={i + 1}>
                  {w}
                </option>
              ))}
            </select>
            <input
              aria-label="本地时间"
              type="time"
              className={styles.field}
              style={{ width: "auto", marginBottom: 0 }}
              defaultValue={t.localTime}
              disabled={pending === t.id}
              onBlur={(e) => e.target.value && e.target.value !== t.localTime && patch(t, { localTime: e.target.value })}
            />
            <button className={styles.btn} disabled={!searchReady || pending === t.id} onClick={() => runNow(t)}>
              立即运行一次
            </button>
          </div>
          <div className={styles.muted}>
            {t.enabled && t.nextRunAt
              ? `下次：${new Date(t.nextRunAt).toLocaleString("zh-CN", { timeZone: t.timezone })}（${t.timezone}）`
              : "未开启定期"}
          </div>
        </div>
      ))}
      <form onSubmit={create} style={{ marginTop: 12 }}>
        <input
          className={styles.field}
          placeholder="新方向，例如：自然语言处理入门"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          className={styles.field}
          placeholder="检索目的（可选）"
          maxLength={1000}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
        <button className={styles.btn} type="submit" disabled={!title.trim() || pending === "create"}>
          添加方向
        </button>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
