import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import PlanView from "@/app/components/PlanView";

export default function PlanPage() {
  return (
    <AppShell currentPath="/plan">
      <div className={styles.pageHeader}>
        <h1>计划</h1>
      </div>
      <PlanView />
    </AppShell>
  );
}
