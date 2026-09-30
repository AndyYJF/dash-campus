import AppShell from "@/app/components/AppShell";
import ExplorationRunView from "@/app/components/ExplorationRunView";

export default function ExplorationRunPage() {
  return (
    <AppShell currentPath="/explore">
      <ExplorationRunView />
    </AppShell>
  );
}
