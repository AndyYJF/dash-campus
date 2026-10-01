import type { ReactNode } from "react";
import styles from "./dash.module.css";

/** 列表页页头：短横小字（英文栏目名）+ 标题 + 一句说明；右侧可放附加内容。 */
export default function PageHeader({
  overline,
  title,
  sub,
  children,
}: {
  overline: string;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.pageHeader}>
      <div>
        <div className={styles.overline}>{overline}</div>
        <h1>{title}</h1>
        {sub && <p className={styles.pageSub}>{sub}</p>}
      </div>
      {children}
    </div>
  );
}
