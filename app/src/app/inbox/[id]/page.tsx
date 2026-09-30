import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import InboxDetailView from "@/app/components/InboxDetailView";

export default function InboxDetailPage() {
  return (
    <AppShell currentPath="/inbox">
      <div className={styles.pageHeader}>
        <h1>通知详情</h1>
      </div>
      <InboxDetailView />
    </AppShell>
  );
}
