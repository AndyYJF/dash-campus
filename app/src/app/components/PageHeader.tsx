import type { ReactNode } from "react";
import styles from "./dash.module.css";

/** 列表页页头：标题 + 一句说明；右侧可放附加内容。overline 是早期版式留下的英文栏目名，不再显示（它只是把标题再说一遍）。 */
export default function PageHeader({
  title,
  sub,
  children,
}: {
  overline?: string;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.pageHeader}>
      <div>
        <h1>{title}</h1>
        {sub && <p className={styles.pageSub}>{sub}</p>}
      </div>
      {children}
    </div>
  );
}
