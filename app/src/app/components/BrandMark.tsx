/** 品牌标记：墨色方块里一道短横（dash）。侧栏、登录与初始化页共用；只做装饰。 */
export default function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false" style={{ flex: "0 0 auto" }}>
      <rect width="28" height="28" rx="4" fill="var(--color-text)" />
      <rect x="7" y="12.5" width="14" height="3" fill="var(--color-bg)" />
    </svg>
  );
}
