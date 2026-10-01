import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import InboxView from "@/app/components/InboxView";

export default function InboxPage() {
  return (
    <AppShell currentPath="/inbox">
      <PageHeader overline="Inbox" title="收件箱" sub="外部来的通知与消息先落在这里，确认后再变成任务。" />
      <InboxView />
    </AppShell>
  );
}
