"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/app/components/dash.module.css";
import AuthLayout from "@/app/components/AuthLayout";

export default function SetupPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    }).catch(() => null);
    if (!res) {
      setBusy(false);
      setError("网络异常，请稍后重试");
      return;
    }
    setBusy(false);
    if (res.ok) {
      router.push("/login");
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? `初始化失败（${res.status}）`);
    }
  }

  return (
    <AuthLayout title="初始化实例" lead="只需做一次：验证部署时设置的 Token，并设定主人密码。" foot="Token 在部署目录的 .env 里（SETUP_TOKEN），初始化完成后即失效。">
      <form onSubmit={submit}>
        <label className={styles.label}>
          初始化 Token
          <input
            className={styles.field}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </label>
        <label className={styles.label}>
          主人密码（至少 8 位）
          <input
            className={styles.field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
          disabled={busy}
        >
          {busy ? "初始化中…" : "初始化"}
        </button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </AuthLayout>
  );
}
