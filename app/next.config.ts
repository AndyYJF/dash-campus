import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 只影响 next dev：允许经 *.localhost 反代（如 AgentBox 的 <box>.localhost）访问 HMR 等开发资源
  allowedDevOrigins: ["*.localhost"],
  turbopack: {
    // 工作区上层还有别的 lockfile，显式锁定项目根
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
