"use client";

import { useEffect } from "react";
import { loginHref } from "./api";

/**
 * 页面加载时确认会话：未登录直接去登录页（此时没有未保存输入）。
 * 提交中途的 401 不在这里处理 —— 由表单提示并保留本机草稿（13.3）。
 */
export default function SessionGuard() {
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/auth/sessions")
      .then((r) => {
        if (!cancelled && r.status === 401) window.location.replace(loginHref());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
