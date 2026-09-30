import AppShell from "@/app/components/AppShell";
import styles from "@/app/components/dash.module.css";
import ReviewsView from "@/app/components/ReviewsView";

export default function ReviewsPage() {
  return (
    <AppShell currentPath="/reviews">
      <div className={styles.pageHeader}>
        <h1>回顾</h1>
      </div>
      <ReviewsView />
    </AppShell>
  );
}
