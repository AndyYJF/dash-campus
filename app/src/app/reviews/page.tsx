import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import ReviewsView from "@/app/components/ReviewsView";

export default function ReviewsPage() {
  return (
    <AppShell currentPath="/reviews">
      <div className={styles.pageHeader}>
        <div>
          <h1>回顾</h1>
          <p className={styles.pageSub}>每周看一次事实、推测与建议，由你决定怎么调整。</p>
        </div>
      </div>
      <ReviewsView />
    </AppShell>
  );
}
