"use client";

import { useEffect } from "react";

/**
 * 页面间的轻量通知：统一输入、问题回答、卡片操作完成后发一次“数据变了”，三页据此重新读共享快照；
 * 时间轴上点空档/活动时把上下文交给统一输入，主人不用重新描述时间和对象。
 */

export const DASH_CHANGED = "dash:changed";
export const DASH_COMPOSE = "dash:compose";

export type EntityRef = { kind: string; id: string };
export type ComposeDetail = { label: string; text?: string; selectedEntityRef?: EntityRef; slot?: { date: string; start: string; end: string } };

export function emitChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DASH_CHANGED));
}

export function compose(detail: ComposeDetail): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<ComposeDetail>(DASH_COMPOSE, { detail }));
}

export function useDashRefresh(refresh: () => void): void {
  useEffect(() => {
    window.addEventListener(DASH_CHANGED, refresh);
    // 回到标签页时也刷新一次：处理可能在后台完成了
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(DASH_CHANGED, refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
}
