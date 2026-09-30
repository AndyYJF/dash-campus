"use client";

import Link from "next/link";
import styles from "./dash.module.css";
import type { TodaySummary } from "@/contracts/today";

/**
 * WeekStatusStrip（产品计划 5.3）：本周重点、剩余已知负担（未知单列）、未来可用容量。
 * 服务端同一 asOf 快照，客户端不另算。负担条只在容量已知且 > 0 时显示；超出时写明至少超出多少。
 */
export default function WeekStatusStrip({ summary }: { summary: TodaySummary }) {
  const { workload, focus, week } = summary;
  const cap = workload.futureCapacityMinutes;
  const known = workload.remainingKnownMinutes;
  const showMeter = cap !== null && cap > 0;
  const over = showMeter && known > cap ? known - cap : 0;
  const pct = showMeter ? Math.min(100, Math.round((known / cap) * 100)) : 0;

  return (
    <section className={styles.strip} aria-label="本周状态">
      <div className={styles.stripItem}>
        <span className={styles.stripLabel}>本周重点</span>
        {focus ? (
          <span className={styles.stripValueText}>{focus.title}</span>
        ) : (
          <span className={styles.stripValueText}>
            尚未设置本周重点 <Link href="/plan">去设置</Link>
          </span>
        )}
        <span className={styles.stripNote}>
          {week.localMonday} 起的一周
          {focus ? ` · 确认于 ${new Date(focus.confirmedAt).toLocaleDateString()}` : ""}
        </span>
      </div>
      <div className={styles.stripItem}>
        <span className={styles.stripLabel}>剩余任务 · 已知估时</span>
        <span className={styles.stripValue}>{formatMinutes(known)}</span>
        <span className={styles.stripNote}>
          {workload.remainingUnknownCount > 0 ? `另有 ${workload.remainingUnknownCount} 项估时未知` : "全部已估时"}
        </span>
      </div>
      <div className={styles.stripItem}>
        <span className={styles.stripLabel}>未来可安排时间</span>
        {cap === null ? (
          <span className={styles.stripValueText}>
            尚未设置可用时间 <Link href="/plan">去设置</Link>
          </span>
        ) : (
          <>
            <span className={styles.stripValue}>{formatMinutes(cap)}</span>
            <span className={styles.stripNote}>已预留 {workload.bufferPercent}% 缓冲</span>
          </>
        )}
        {showMeter && (
          <>
            <div
              className={styles.meter}
              role="img"
              aria-label={over > 0 ? `已知负担至少超出可用时间 ${formatMinutes(over)}` : `已知负担占可用时间 ${pct}%`}
            >
              <div className={`${styles.meterFill} ${over > 0 ? styles.meterOver : ""}`} style={{ width: `${pct}%` }} />
            </div>
            {over > 0 && <span className={styles.stripNote}>至少超出 {formatMinutes(over)}</span>}
          </>
        )}
      </div>
    </section>
  );
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}
