import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import ExploreView from "@/app/components/ExploreView";

export default function ExplorePage() {
  return (
    <AppShell currentPath="/explore">
      <div className={styles.pageHeader}>
        <div>
          <h1>探索</h1>
          <p className={styles.pageSub}>带着问题找方向：检索资料、比较候选实践，再决定要不要动手。</p>
        </div>
      </div>
      <ExploreView />
    </AppShell>
  );
}
