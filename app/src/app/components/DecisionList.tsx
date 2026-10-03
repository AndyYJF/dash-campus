"use client";

import Link from "next/link";
import Icon from "./Icon";
import styles from "./dash.module.css";
import type { TodaySummary } from "@/contracts/today";

/** 需要你决定（产品计划 5.3）：条件待确认与有效提案；最多三项，显示剩余数量。每项整块可点。 */
export default function DecisionList({ summary }: { summary: TodaySummary }) {
  return (
    <section className={styles.card} aria-labelledby="decisions-title">
      <h2 id="decisions-title">需要你决定</h2>
      {summary.decisions.length === 0 && <p className={styles.empty}>目前没有需要你处理的事项。</p>}
      {summary.decisions.map((d) => (
        <Link key={d.id} href={d.href} className={styles.decision} aria-label={`${d.title}：查看依据并处理`}>
          <span className={styles.decisionBody}>
            <span className={`${styles.badge} ${d.kind === "proposal" ? styles.badgeAccent : styles.badgeHigh}`}>
              {d.kind === "proposal" ? "计划调整" : "条件待确认"}
            </span>
            <span className={styles.decisionTitle}>{d.title}</span>
          </span>
          <Icon name="arrowRight" size={16} className={styles.decisionArrow} />
        </Link>
      ))}
      {summary.moreDecisionCount > 0 && (
        <p className={styles.muted}>
          还有 {summary.moreDecisionCount} 项；通知去<Link href="/inbox">收件箱</Link>，计划提案去<Link href="/reviews">回顾页</Link>处理。
        </p>
      )}
    </section>
  );
}
