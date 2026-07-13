import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "研面 · 保研模拟面试",
  description: "基于百炼大模型的电子信息保研模拟面试训练台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
