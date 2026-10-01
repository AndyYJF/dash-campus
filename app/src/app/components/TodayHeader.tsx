"use client";

import { useSyncExternalStore } from "react";
import styles from "./dash.module.css";

/** 每分钟刷新一次，跨过整点或零点时问候语和日期跟着变 */
function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

function clientText(): string {
  const now = new Date();
  const h = now.getHours();
  const greeting = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const date = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  return `${greeting}，今天是 ${date}`;
}

/** 今天页页头：问候语与日期按浏览器本地时间显示；服务端渲染时留空，水合后填入，不产生不一致。 */
export default function TodayHeader() {
  const text = useSyncExternalStore(subscribe, clientText, () => "");
  return (
    <div className={styles.pageHeader}>
      <div>
        <h1>今天</h1>
        <p className={styles.pageSub}>{text || " "}</p>
      </div>
    </div>
  );
}
