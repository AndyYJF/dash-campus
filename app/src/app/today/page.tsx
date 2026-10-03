import AppShell from "@/app/components/AppShell";
import V2TodayView from "@/app/components/V2TodayView";

export default function TodayPage() {
  return (
    <AppShell currentPath="/today">
      <V2TodayView />
    </AppShell>
  );
}
