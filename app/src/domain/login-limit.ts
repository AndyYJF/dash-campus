/**
 * 登录限速：按来源地址统计失败次数，窗口内超过上限返回 429。
 * 另设全局上限，防止换地址穷举。只在内存里计数：web 单进程，重启清零可以接受。
 * 成功登录清掉该地址的计数。
 */

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES_PER_CLIENT = 10;
export const LOGIN_MAX_FAILURES_GLOBAL = 100;

const GLOBAL_KEY = "*";
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** 被限速时返回需要等待的秒数，否则 null */
export function loginBlockedFor(client: string, now = Date.now()): number | null {
  const own = recent(client, now);
  const all = recent(GLOBAL_KEY, now);
  const blockedBy =
    own.length >= LOGIN_MAX_FAILURES_PER_CLIENT ? own : all.length >= LOGIN_MAX_FAILURES_GLOBAL ? all : null;
  if (!blockedBy) return null;
  return Math.max(1, Math.ceil((blockedBy[0]! + LOGIN_WINDOW_MS - now) / 1000));
}

export function recordLoginFailure(client: string, now = Date.now()): void {
  for (const key of [client, GLOBAL_KEY]) failures.set(key, [...recent(key, now), now]);
}

export function clearLoginFailures(client: string): void {
  failures.delete(client);
}

export function resetLoginLimits(): void {
  failures.clear();
}

/**
 * 来源地址：web 只监听环回，前面是反向代理（Caddy 会覆写 X-Forwarded-For），
 * 取最后一跳；没有代理头时统一记为 local。
 */
export function clientKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || headers.get("x-real-ip") || "local";
}
