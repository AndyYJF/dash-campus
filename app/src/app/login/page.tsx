"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import styles from "@/app/components/dash.module.css";
import auth from "@/app/components/auth.module.css";
import AuthLayout from "@/app/components/AuthLayout";
import { enterDemo, useDemoStatus, type EnterResult } from "@/app/components/demoStatus";

/** 登录后去哪：只接受站内相对路径，防止开放重定向 */
function nextTarget(): { next: string | null; target: string } {
  const next = new URLSearchParams(window.location.search).get("next");
  return { next, target: next && next.startsWith("/") && !next.startsWith("//") ? next : "/today" };
}

/** 演示入口直接指到演示实例的进入页：省掉“先打开工作台、发现没会话、再转回来”的一跳 */
function demoEntryHref(demoUrl: string): string {
  try {
    return new URL("/login", demoUrl).toString();
  } catch {
    return demoUrl;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { status } = useDemoStatus();
  const isDemo = status?.demo === true;

  /** 演示实例：领到访客会话之后去哪 */
  const afterEnter = useCallback(
    (r: EnterResult) => {
      if (!r.ok) {
        setBusy(false);
        setError(r.message);
        return;
      }
      const { next, target } = nextTarget();
      if (window.opener && next) {
        setBusy(false);
        setDone(true);
        return;
      }
      router.push(target);
    },
    [router],
  );

  // 演示实例上打开登录页（包括会话过期被带过来）就自动进入，访客不用输密码也不用点任何东西
  useEffect(() => {
    if (!isDemo) return;
    let cancelled = false;
    enterDemo().then((r) => {
      if (!cancelled) afterEnter(r);
    });
    return () => {
      cancelled = true;
    };
  }, [isDemo, afterEnter]);

  /** 自动进入失败后手动重试 */
  function retryEnter() {
    setBusy(true);
    setError(null);
    void enterDemo().then(afterEnter);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (!res) {
      setBusy(false);
      setError("网络异常，请稍后重试");
      return;
    }
    if (res.ok) {
      const body = await res.json();
      localStorage.setItem("csrfToken", body.csrfToken);
      const { next, target } = nextTarget();
      // 在新标签页登录（从表单错误提示打开）时，登录后关闭本页即可回到原页面继续提交
      if (window.opener && next) {
        setDone(true);
        return;
      }
      router.push(target);
      return;
    }
    setBusy(false);
    const body = await res.json().catch(() => null);
    setError(body?.error?.message ?? `登录失败（${res.status}）`);
  }

  if (isDemo) {
    return (
      <AuthLayout title="演示模式" lead="不需要账号。这里是合成的示例数据，可以随便试，每天自动恢复。" foot="演示实例与正式数据完全分开，所有访客共用一份示例。">
        <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`} onClick={retryEnter} disabled={busy || (!error && !done)}>
          {busy || (!error && !done) ? "正在进入…" : "进入演示"}
        </button>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className={`${styles.notice} ${styles.noticeOk}`} role="status">
            已进入演示。可以关闭本页，回到原来的页面再点一次提交。
          </p>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="欢迎回来" lead="输入密码，继续今天的计划与记录。" foot="单用户自部署实例，数据只保存在你自己的服务器上。">
      <form onSubmit={submit}>
        <label className={styles.label}>
          密码
          <input
            className={styles.field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
          disabled={busy}
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className={`${styles.notice} ${styles.noticeOk}`} role="status">
          已登录。可以关闭本页，回到原来的页面再点一次提交。
        </p>
      )}
      {status && !status.demo && status.demoUrl && (
        <div className={auth.demoEntry}>
          <p className={auth.demoLead}>只是想看看？</p>
          <a className={`${styles.btn} ${auth.demoButton}`} href={demoEntryHref(status.demoUrl)}>
            进入演示模式
          </a>
          <p className={auth.demoNote}>不需要账号。演示用的是合成示例数据，和这里的数据完全分开。</p>
        </div>
      )}
    </AuthLayout>
  );
}
