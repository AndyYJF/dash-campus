import AppShell from "@/app/components/AppShell";
import V2WeekView from "@/app/components/V2WeekView";

export default function WeekPage() {
  return (
    <AppShell currentPath="/week">
      <V2WeekView />
    </AppShell>
  );
}
