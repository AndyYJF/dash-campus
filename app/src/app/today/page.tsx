import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import TodayView from "@/app/components/TodayView";

export default function TodayPage() {
  return (
    <AppShell currentPath="/today">
      <div className={styles.pageHeader}>
        <h1>今天</h1>
      </div>
      <TodayView />
    </AppShell>
  );
}
