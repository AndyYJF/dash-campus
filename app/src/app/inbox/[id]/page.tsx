import AppShell from "@/app/components/AppShell";
import BackLink from "@/app/components/BackLink";
import styles from "@/app/components/dash.module.css";
import InboxDetailView from "@/app/components/InboxDetailView";

export default function InboxDetailPage() {
  return (
    <AppShell currentPath="/inbox">
      <div className={styles.pageHeader}>
        <div>
          <BackLink href="/inbox" label="收件箱" />
          <h1>通知详情</h1>
        </div>
      </div>
      <InboxDetailView />
    </AppShell>
  );
}
