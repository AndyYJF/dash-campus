import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import InboxView from "@/app/components/InboxView";

export default function InboxPage() {
  return (
    <AppShell currentPath="/inbox">
      <div className={styles.pageHeader}>
        <h1>收件箱</h1>
      </div>
      <InboxView />
    </AppShell>
  );
}
