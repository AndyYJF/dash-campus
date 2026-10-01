import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import SettingsView from "@/app/components/SettingsView";

export default function SettingsPage() {
  return (
    <AppShell currentPath="/settings">
      <PageHeader overline="Settings" title="设置" sub="集成状态、提醒邮件、AI 用量与数据导出。" />
      <SettingsView />
    </AppShell>
  );
}
