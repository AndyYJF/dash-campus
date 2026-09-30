"use client";

import { ApiError, loginHref } from "./api";
import styles from "./dash.module.css";

/**
 * 表单错误提示：401 时给出新标签页登录入口（当前页输入保留），其他错误原样说明。
 * 不显示虚假成功（U3）。
 */
export function errorText(e: unknown, fallback = "操作失败，内容已保留"): string {
  if (e instanceof ApiError) return e.status === 409 && e.code === "CONFLICT" ? "已在别处修改，请刷新后重试（输入已保留）" : e.message;
  return fallback;
}

export default function ErrorNote({ error }: { error: { message: string; status?: number } | null }) {
  if (!error) return null;
  return (
    <p className={styles.error} role="alert">
      {error.message}
      {error.status === 401 && (
        <>
          {" "}
          <a href={loginHref()} target="_blank" rel="noopener">
            在新标签页登录
          </a>
          ，登录后回到这里再点一次提交。
        </>
      )}
    </p>
  );
}

export function toErrorState(e: unknown, fallback?: string): { message: string; status?: number } {
  return { message: errorText(e, fallback), status: e instanceof ApiError ? e.status : undefined };
}
