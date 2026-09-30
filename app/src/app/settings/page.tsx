import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import SettingsView from "@/app/components/SettingsView";

export default function SettingsPage() {
  return (
    <AppShell currentPath="/settings">
      <div className={styles.pageHeader}>
        <h1>设置</h1>
      </div>
      <SettingsView />
    </AppShell>
  );
}
