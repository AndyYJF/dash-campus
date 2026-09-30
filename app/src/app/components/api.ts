/** 前端 API 小助手：自动带 CSRF 头；抛错时携带服务端 error body */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function csrf(): string {
  return typeof window !== "undefined" ? (localStorage.getItem("csrfToken") ?? "") : "";
}

/** 当前页面的登录链接（登录后回到这里） */
export function loginHref(): string {
  if (typeof window === "undefined") return "/login";
  const here = window.location.pathname + window.location.search;
  return `/login?next=${encodeURIComponent(here)}`;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.method && options.method !== "GET" ? { "x-csrf-token": csrf() } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "网络异常，请求未完成；内容已保留，可重试");
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401) {
    // 会话失效：不整页跳转（会丢掉未保存输入），由调用方提示并保留草稿（13.3）
    throw new ApiError(401, "UNAUTHORIZED", "登录已过期，内容已保存在本机。请重新登录后再提交");
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? `请求失败（${res.status}）`);
  }
  return body as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
