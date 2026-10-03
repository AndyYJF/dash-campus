import AppShell from "@/app/components/AppShell";
import PageHeader from "@/app/components/PageHeader";
import NotificationsPanel from "@/app/components/NotificationsPanel";
export default function NotificationsPage() {
  return <AppShell currentPath="/notifications"><PageHeader overline="Notifications" title="提醒与投递" sub="查看未来提醒、发送结果和需要处理的投递。" /><NotificationsPanel /></AppShell>;
}
