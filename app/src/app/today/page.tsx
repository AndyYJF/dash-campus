import AppShell from "@/app/components/AppShell";
import TodayHeader from "@/app/components/TodayHeader";
import TodayView from "@/app/components/TodayView";

export default function TodayPage() {
  return (
    <AppShell currentPath="/today">
      <TodayHeader />
      <TodayView />
    </AppShell>
  );
}
