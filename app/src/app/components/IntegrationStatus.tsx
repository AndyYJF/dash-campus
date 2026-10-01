import Icon, { type IconName } from "./Icon";
import styles from "./dash.module.css";
import type { IntegrationStatusMap } from "@/contracts/integration-status";

/** 集成状态只显示 configured/not_configured/error，不显示任何 secret */
export default function IntegrationStatus({ integrations }: { integrations: IntegrationStatusMap }) {
  const items: Array<{ key: keyof IntegrationStatusMap; label: string; icon: IconName; use: string }> = [
    { key: "model", label: "模型", icon: "sparkles", use: "探索、复盘推测、卡点分析" },
    { key: "search", label: "搜索", icon: "explore", use: "探索时检索外部资料" },
    { key: "smtp", label: "邮件", icon: "mail", use: "截止提醒与测试邮件" },
  ];
  return (
    <div className={styles.strip}>
      {items.map(({ key, label, icon, use }) => {
        const s = integrations[key];
        return (
          <div key={key} className={styles.stripItem}>
            <span className={styles.stripLabel}>
              <span className={styles.stripIcon}>
                <Icon name={icon} size={16} />
              </span>
              {label}
            </span>
            <span className={styles.stripValueText}>
              {s.state === "configured" && <span className={`${styles.badge} ${styles.badgeOk}`}>已配置</span>}
              {s.state === "not_configured" && <span className={`${styles.badge} ${styles.badgeOutline}`}>未配置</span>}
              {s.state === "error" && <span className={`${styles.badge} ${styles.badgeOverdue}`}>配置错误</span>}
            </span>
            <span className={styles.stripNote}>{s.state === "error" ? s.detail : use}</span>
          </div>
        );
      })}
    </div>
  );
}
