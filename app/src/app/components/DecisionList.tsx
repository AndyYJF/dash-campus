"use client";

import Link from "next/link";
import styles from "./dash.module.css";
import type { TodaySummary } from "@/contracts/today";

/** 需要你决定（产品计划 5.3）：条件待确认与有效提案；最多三项，显示剩余数量 */
export default function DecisionList({ summary }: { summary: TodaySummary }) {
  return (
    <section className={styles.card} aria-labelledby="decisions-title">
      <h2 id="decisions-title">需要你决定</h2>
      {summary.decisions.length === 0 && <p className={styles.empty}>目前没有需要你处理的事项。</p>}
      {summary.decisions.map((d) => (
        <div key={d.id} className={styles.taskRow}>
          <div className={styles.taskBody}>
            <span className={styles.taskTitle}>
              <span className={`${styles.badge} ${d.kind === "proposal" ? styles.badgeAccent : styles.badgeHigh}`}>
                {d.kind === "proposal" ? "计划调整" : "条件待确认"}
              </span>{" "}
              {d.title}
            </span>
            <span className={styles.taskMeta}>
              <Link href={d.href}>查看依据并处理</Link>
            </span>
          </div>
        </div>
      ))}
      {summary.moreDecisionCount > 0 && (
        <p className={styles.muted}>
          还有 {summary.moreDecisionCount} 项，<Link href="/reviews">去回顾页处理</Link>。
        </p>
      )}
    </section>
  );
}
