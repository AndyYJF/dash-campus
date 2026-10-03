"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import styles from "./v2.module.css";

/** V2 方向页：目标、实践证据、诚实声明。没有证据就承认，不编造概率与分数。 */

type Direction = {
  goals: Array<{ id: string; title: string; status: string }>;
  practice: Array<{ id: string; occurredOn: string; actualMinutes: number | null; note: string }>;
  candidates: Array<{ title: string; deliverable: string; fitReason: string; evidenceStatus: string; canonicalUrl: string | null }>;
  evidenceState: string;
  honesty: string;
};

export default function V2DirectionView() {
  const [data, setData] = useState<Direction | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<Direction>("/api/v2/direction").then(setData).catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!data) return <p className={styles.muted}>加载中…</p>;

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h2 className={styles.title}>方向</h2>
        <p className={styles.muted}>{data.honesty}</p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>目标</h2>
        {data.goals.length === 0 && <p className={styles.muted}>还没有目标。</p>}
        {data.goals.map((g) => (
          <p key={g.id} className={styles.sessionTitle}>{g.title}{g.status === "paused" && <em className={styles.badge}>暂停</em>}</p>
        ))}
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>方向候选</h2>
        {data.candidates.length === 0 && <p className={styles.muted}>暂无候选。探索有新结果时会出现在这里（最多 3 个，均带来源）。</p>}
        {data.candidates.map((c) => (
          <div key={c.title} className={styles.session}>
            <span className={styles.sessionTitle}>{c.title}</span>
            {c.canonicalUrl ? (
              <a href={c.canonicalUrl} target="_blank" rel="noreferrer" className={styles.muted}>来源↗</a>
            ) : (
              <em className={styles.badge}>无链接</em>
            )}
            <span className={styles.muted}>{c.deliverable && `交付：${c.deliverable} · `}证据：{c.evidenceStatus}</span>
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>实践记录</h2>
        {data.practice.length === 0 && <p className={styles.muted}>还没有实践记录。在顶部输入框说一句「今天学了…」就会出现在这里。</p>}
        {data.practice.map((p) => (
          <div key={p.id} className={styles.session}>
            <span className={styles.muted}>{p.occurredOn}</span>
            <span className={styles.sessionTitle}>{p.note || "实践"}</span>
            <span className={styles.muted}>{p.actualMinutes === null ? "分钟未知" : `${p.actualMinutes} 分钟`}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
