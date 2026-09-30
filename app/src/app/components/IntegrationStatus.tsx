import type { IntegrationStatusMap } from "@/contracts/integration-status";

/** 集成状态只显示 configured/not_configured/error，不显示任何 secret */
export default function IntegrationStatus({ integrations }: { integrations: IntegrationStatusMap }) {
  const items: Array<{ key: keyof IntegrationStatusMap; label: string }> = [
    { key: "model", label: "模型" },
    { key: "search", label: "搜索" },
    { key: "smtp", label: "邮件" },
  ];
  return (
    <ul>
      {items.map(({ key, label }) => {
        const s = integrations[key];
        return (
          <li key={key}>
            {label}：
            {s.state === "configured" && <span>已配置</span>}
            {s.state === "not_configured" && <span>未配置</span>}
            {s.state === "error" && <span>配置错误（{s.detail}）</span>}
            {s.state !== "configured" && (
              <a href="/settings" style={{ marginLeft: 8 }}>
                去设置
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
