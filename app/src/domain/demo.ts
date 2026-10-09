import { getConfig } from "@/config";

/**
 * 展示模式（docs/demo-mode.md）：给没有账号的人完整试用的独立实例。
 * - 只在单独部署的演示实例上打开（DEMO_MODE=1），连的是带演示标记的合成数据库，和正式实例不共用进程、数据和密钥；
 * - 访客不输密码，进入时领一个访客会话，之后走的接口、Agent 和页面与正式实例是同一套；
 * - 所有访客共用这一份数据，每天恢复成初始示例，页面上也能手动恢复；
 * - 下面两张表是公开匿名访问才需要的护栏：会碰到实例外部或别的访客的入口关掉，写入和 AI 请求限速。
 * 纯函数与进程内计数，不读库。
 */

export function isDemoMode(): boolean {
  return getConfig().DEMO_MODE;
}

/** 演示实例与正式实例可能同域不同端口，Cookie 不按端口隔离：用不同的名字，互不覆盖 */
export const DEMO_SESSION_COOKIE = "dash_demo_session";
/** 访客会话有效期：一天，过期后重新进入即可 */
export const DEMO_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type Rule = { methods?: string[]; pattern: RegExp; reason: string };

/**
 * 演示实例上关掉的入口。原则：只关“会碰到实例之外”或“会影响别的访客会话”的，
 * 业务功能（任务、课表、安排、探索、复盘、资讯、方向、导出）全部保留。
 */
const BLOCKED: Rule[] = [
  { pattern: /^\/api\/v1\/auth\/sessions\/[^/]+$/, methods: ["DELETE"], reason: "演示模式下访客会话由系统管理，不能撤销" },
  { pattern: /^\/api\/v1\/legacy(\/|$)/, reason: "演示模式不接旧工具，旧数据导入已关闭" },
  { pattern: /^\/api\/v1\/inbox\/sources(\/|$)/, methods: ["POST", "PATCH"], reason: "演示模式不签发外部推送口令；可以直接在页面里粘贴通知原文" },
  { pattern: /^\/api\/v1\/mail\/test$/, reason: "演示模式不发送邮件" },
  { pattern: /^\/api\/v1\/deliveries\/[^/]+\/resend$/, reason: "演示模式不发送邮件" },
  { pattern: /^\/api\/v1\/integrations\/model-capabilities$/, methods: ["POST"], reason: "演示模式不重新探测模型端点" },
];

/** 命中则返回说明文字；不拦返回 null */
export function demoBlockedReason(method: string, pathname: string): string | null {
  const m = method.toUpperCase();
  const hit = BLOCKED.find((r) => r.pattern.test(pathname) && (!r.methods || r.methods.includes(m)));
  return hit ? hit.reason : null;
}

/** 会发起模型或搜索请求的入口：单独限速（全站每日上限之外，防一个人短时间用光） */
const AI_ENTRY: RegExp[] = [
  /^\/api\/v2\/intakes(\/[^/]+\/retry)?$/,
  /^\/api\/v2\/questions\/[^/]+\/answers$/,
  /^\/api\/v1\/explorations$/,
  /^\/api\/v1\/exploration-topics\/[^/]+\/run$/,
  /^\/api\/v1\/reviews\/generate$/,
  /^\/api\/v1\/assistant\/requests$/,
  /^\/api\/v1\/inbox\/[^/]+\/extract$/,
  /^\/api\/v1\/inbox\/manual$/,
];

export function isAiEntry(pathname: string): boolean {
  return AI_ENTRY.some((r) => r.test(pathname));
}

export const DEMO_RATE_WINDOW_MS = 10 * 60 * 1000;
/** 每个访客会话 / 每个来源地址，10 分钟内的写入次数与其中的 AI 请求次数；来源地址放宽，教室里常共用一个出口 */
export const DEMO_LIMITS = {
  session: { write: 200, ai: 30 },
  client: { write: 1000, ai: 150 },
  /** 每个来源地址 10 分钟内可以领的访客会话数 */
  enterPerClient: 40,
  /** 手动恢复示例数据的最短间隔 */
  resetCooldownMs: 5 * 60 * 1000,
} as const;

const hits = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < DEMO_RATE_WINDOW_MS);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

/** 计一次并判断是否超限；超限时返回需要等待的秒数（这一次不计入） */
export function demoRateHit(key: string, max: number, now = Date.now()): number | null {
  const list = recent(key, now);
  if (list.length >= max) return Math.max(1, Math.ceil((list[0]! + DEMO_RATE_WINDOW_MS - now) / 1000));
  hits.set(key, [...list, now]);
  // 计数表不无限增长：访客会话一天一换，偶尔清掉已经空窗的键
  if (hits.size > 5000) for (const k of [...hits.keys()]) recent(k, now);
  return null;
}

export function resetDemoRateLimits(): void {
  hits.clear();
}

/**
 * 一次写请求的限速判定：先看来源地址，再看访客会话；AI 入口另计一组更紧的。
 * 返回 null 表示放行。
 */
export function demoWriteLimited(input: { sessionId: string; client: string; pathname: string }, now = Date.now()): number | null {
  const ai = isAiEntry(input.pathname);
  const checks: Array<[string, number]> = [
    [`w:c:${input.client}`, DEMO_LIMITS.client.write],
    [`w:s:${input.sessionId}`, DEMO_LIMITS.session.write],
    ...(ai
      ? ([
          [`a:c:${input.client}`, DEMO_LIMITS.client.ai],
          [`a:s:${input.sessionId}`, DEMO_LIMITS.session.ai],
        ] as Array<[string, number]>)
      : []),
  ];
  for (const [key, max] of checks) {
    const wait = demoRateHit(key, max, now);
    if (wait !== null) return wait;
  }
  return null;
}
