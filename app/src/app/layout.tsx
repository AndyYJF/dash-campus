import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dash Campus",
  description: "单用户学习与职业探索工作台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#101413" },
  ],
};

/**
 * 首次绘制前应用手动选择的主题（localStorage.theme = light | dark；没有则跟随系统）。
 * 内联脚本在解析 HTML 时同步执行，避免先按系统主题画一帧再切换。
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

// 字体用系统中文无衬线（globals.css），不发外部字体请求
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme 由上面的内联脚本在水合前写入，服务端渲染结果里没有
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
