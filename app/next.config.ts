import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // 工作区上层还有别的 lockfile，显式锁定项目根
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
