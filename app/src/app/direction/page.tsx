import AppShell from "@/app/components/AppShell";
import V2DirectionView from "@/app/components/V2DirectionView";

export default function DirectionPage() {
  return (
    <AppShell currentPath="/direction">
      <V2DirectionView />
    </AppShell>
  );
}
