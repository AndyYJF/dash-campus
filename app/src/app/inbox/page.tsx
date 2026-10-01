import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import InboxView from "@/app/components/InboxView";

export default function InboxPage() {
  return (
    <AppShell currentPath="/inbox">
      <div className={styles.pageHeader}>
        <div>
          <h1>收件箱</h1>
          <p className={styles.pageSub}>外部来的通知与消息先落在这里，确认后再变成任务。</p>
        </div>
      </div>
      <InboxView />
    </AppShell>
  );
}
