import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import ExploreView from "@/app/components/ExploreView";

export default function ExplorePage() {
  return (
    <AppShell currentPath="/explore">
      <PageHeader overline="Explore" title="探索" sub="带着问题找方向：检索资料、比较候选实践，再决定要不要动手。" />
      <ExploreView />
    </AppShell>
  );
}
