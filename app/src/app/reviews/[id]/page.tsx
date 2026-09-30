import AppShell from "@/app/components/AppShell";
import ReviewDetailView from "@/app/components/ReviewDetailView";

export default function ReviewDetailPage() {
  return (
    <AppShell currentPath="/reviews">
      <ReviewDetailView />
    </AppShell>
  );
}
