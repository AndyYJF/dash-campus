"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/app/components/dash.module.css";
import auth from "@/app/components/auth.module.css";
import Icon from "@/app/components/Icon";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

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
      // 只接受站内相对路径，防止开放重定向
      const next = new URLSearchParams(window.location.search).get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/today";
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

  return (
    <main className={auth.wrap}>
      <div className={auth.panel}>
        <div className={auth.brand}>
          <span className={auth.mark} aria-hidden="true">
            D
          </span>
          Dash Campus
        </div>
        <h1>欢迎回来</h1>
        <p className={auth.lead}>输入密码，继续今天的计划与记录。</p>
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
      </div>
      <p className={auth.foot}>
        <Icon name="lock" size={14} />
        单用户自部署实例，数据只保存在你自己的服务器上。
      </p>
    </main>
  );
}
