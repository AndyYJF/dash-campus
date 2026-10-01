import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import PlanView from "@/app/components/PlanView";

export default function PlanPage() {
  return (
    <AppShell currentPath="/plan">
      <div className={styles.pageHeader}>
        <div>
          <h1>计划</h1>
          <p className={styles.pageSub}>定下本周重点，看清负担放不放得下，再安排任务。</p>
        </div>
      </div>
      <PlanView />
    </AppShell>
  );
}
