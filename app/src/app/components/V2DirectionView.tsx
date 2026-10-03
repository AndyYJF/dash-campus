"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import styles from "./v2.module.css";

/** V2 方向页：目标、实践证据、诚实声明。没有证据就承认，不编造概率与分数。 */

type Direction = {
  goals: Array<{ id: string; title: string; status: string }>;
  practice: Array<{ id: string; occurredOn: string; actualMinutes: number | null; note: string }>;
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
