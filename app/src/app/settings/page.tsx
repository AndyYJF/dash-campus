import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import SettingsView from "@/app/components/SettingsView";

export default function SettingsPage() {
  return (
    <AppShell currentPath="/settings">
      <div className={styles.pageHeader}>
        <div>
          <h1>设置</h1>
          <p className={styles.pageSub}>集成状态、提醒邮件、AI 用量与数据导出。</p>
        </div>
      </div>
      <SettingsView />
    </AppShell>
  );
}
