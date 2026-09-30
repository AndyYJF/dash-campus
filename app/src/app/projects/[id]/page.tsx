import AppShell from "@/app/components/AppShell";
import ProjectView from "@/app/components/ProjectView";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell currentPath="/plan">
      <ProjectView projectId={id} />
    </AppShell>
  );
}
