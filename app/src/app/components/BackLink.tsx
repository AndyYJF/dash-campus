import Link from "next/link";
import Icon from "./Icon";
import styles from "./dash.module.css";

/** 详情页顶部的返回链接 */
export default function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={styles.backLink}>
      <Icon name="arrowLeft" size={16} />
      {label}
    </Link>
  );
}
