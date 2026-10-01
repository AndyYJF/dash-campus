import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import PlanView from "@/app/components/PlanView";

export default function PlanPage() {
  return (
    <AppShell currentPath="/plan">
      <PageHeader overline="Plan" title="计划" sub="定下本周重点，看清负担放不放得下，再安排任务。" />
      <PlanView />
    </AppShell>
  );
}
