import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import ReviewsView from "@/app/components/ReviewsView";

export default function ReviewsPage() {
  return (
    <AppShell currentPath="/reviews">
      <PageHeader overline="Review" title="回顾" sub="每周看一次事实、推测与建议，由你决定怎么调整。" />
      <ReviewsView />
    </AppShell>
  );
}
