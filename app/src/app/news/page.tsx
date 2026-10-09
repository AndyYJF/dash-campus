import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import NewsView from "@/app/components/NewsView";
export default function NewsPage() {
  return (
    <AppShell currentPath="/news">
      <PageHeader
        title="AI资讯"
        sub="模型、Agent、科研与应用。先看发生了什么，再看它与你有什么关系。"
      />
      <NewsView />
    </AppShell>
  );
}
