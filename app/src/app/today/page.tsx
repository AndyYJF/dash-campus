import AppShell from "@/app/components/AppShell";
import TodayView from "@/app/components/TodayView";

export default function TodayPage() {
  return (
    <AppShell currentPath="/today">
      <TodayView />
    </AppShell>
  );
}
