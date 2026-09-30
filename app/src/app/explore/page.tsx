import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import ExploreView from "@/app/components/ExploreView";

export default function ExplorePage() {
  return (
    <AppShell currentPath="/explore">
      <div className={styles.pageHeader}>
        <h1>探索</h1>
      </div>
      <ExploreView />
    </AppShell>
  );
}
