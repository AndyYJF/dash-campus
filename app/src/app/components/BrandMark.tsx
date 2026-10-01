/** 品牌标记：荧光色方块里一道短横（dash）。侧栏、登录与初始化页共用；只做装饰。 */
export default function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false" style={{ flex: "0 0 auto" }}>
      <rect width="28" height="28" rx="8" fill="var(--color-primary)" />
      <rect x="7" y="12" width="14" height="4" rx="2" fill="var(--color-primary-text)" />
    </svg>
  );
}
