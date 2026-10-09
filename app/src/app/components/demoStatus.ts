"use client";

import { useCallback, useEffect, useState } from "react";

/** GET /api/v1/demo 的返回（workflows/demo.ts 的 DemoStatus） */
export type DemoStatus =
  | { demo: false; demoUrl: string | null }
  | {
      demo: true;
      demoUrl: null;
      seededAt: string | null;
      nextResetAt: string;
      resetHour: number;
      resetCooldownSeconds: number;
      ai: { used: number; limit: number; configured: boolean };
    };

export async function fetchDemoStatus(): Promise<DemoStatus | null> {
  try {
    const res = await fetch("/api/v1/demo", { cache: "no-store" });
    return res.ok ? ((await res.json()) as DemoStatus) : null;
  } catch {
    return null;
  }
}

/** 展示模式状态：null 表示还没读到（或读取失败，按普通实例处理） */
export function useDemoStatus(): { status: DemoStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const refresh = useCallback(async () => {
    const next = await fetchDemoStatus();
    if (next) setStatus(next);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetchDemoStatus().then((next) => {
      if (!cancelled && next) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { status, refresh };
}

export type EnterResult = { ok: true } | { ok: false; message: string };

let entering: Promise<EnterResult> | null = null;

/** 领访客会话并把 CSRF 令牌放到和登录后相同的位置；失败时返回说明文字。同时发起的多次调用共用一次请求 */
export function enterDemo(): Promise<EnterResult> {
  entering ??= requestEnter().finally(() => {
    entering = null;
  });
  return entering;
}

async function requestEnter(): Promise<EnterResult> {
  const res = await fetch("/api/v1/demo/enter", { method: "POST" }).catch(() => null);
  if (!res) return { ok: false, message: "网络异常，请稍后重试" };
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, message: body?.error?.message ?? `进入演示失败（${res.status}）` };
  try {
    localStorage.setItem("csrfToken", body.csrfToken);
  } catch {
    return { ok: false, message: "浏览器禁用了本地存储，演示无法保存会话信息" };
  }
  return { ok: true };
}
