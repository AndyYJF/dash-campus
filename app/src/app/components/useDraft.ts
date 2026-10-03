"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 本机草稿（13.3 / F17 / U7）：表单内容随输入写入 localStorage，
 * 会话过期、刷新或重新登录后不丢；保存成功后由调用方 clear()。
 * 只存在本机浏览器，不上传；不要放密码等敏感内容。
 */
export function useDraft<T extends object>(key: string, initial: T) {
  const storageKey = `draft:${key}`;
  const initialRef = useRef(initial);
  const [value, setValue] = useState<T>(initial);
  const [restored, setRestored] = useState(false);
  // 读取完成才允许写回：用 state 而不是 ref —— 同一轮 effect 里写回会用初始空值覆盖刚读到的草稿
  // （clientEntryId 随之丢失，重新登录后再提交就成了新记录）
  const [loaded, setLoaded] = useState(false);
  const [persisted, setPersisted] = useState(false);

  // 首次挂载时读取（SSR 期间没有 localStorage）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { v: T };
        setValue({ ...initialRef.current, ...saved.v });
        setRestored(true);
      }
    } catch {
      // 损坏的草稿直接忽略
    }
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    let saved = false;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ v: value, at: Date.now() }));
      saved = true;
    } catch {
      // 存储满或被禁用：草稿退化为仅内存
    }
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setPersisted(saved); });
    return () => { cancelled = true; };
  }, [storageKey, value, loaded]);

  const update = useCallback((patch: Partial<T>) => { setPersisted(false); setValue((v) => ({ ...v, ...patch })); }, []);

  const clear = useCallback(
    (next?: Partial<T>) => {
      try { localStorage.removeItem(storageKey); } catch { /* Saving to server already succeeded. */ }
      setPersisted(false);
      setRestored(false);
      setValue({ ...initialRef.current, ...next });
    },
    [storageKey],
  );

  return { value, update, clear, restored, loaded, persisted };
}
