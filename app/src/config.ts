import { z } from "zod";

/**
 * 服务端配置 schema。配置名以 CODING-AGENT-开发执行计划 v1.2 第 3 节为准。
 * secret 只存在于服务端，前端只能看到 IntegrationStatus（configured/not_configured/error）。
 */

// .env 里的空值是 "" 不是 undefined；统一把空串当作未配置
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

// 数字型可选项：空串当作未配置，走默认值
const numberWithDefault = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(fallback),
  );

export const configSchema = z.object({
  // 应用
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().min(1).default("Asia/Shanghai"),
  DATABASE_PATH: z.string().min(1).default("./data/dash-campus.db"),
  SETUP_TOKEN: optionalString,

  // 模型
  MODEL_PROTOCOL: optionalString,
  MODEL_ENDPOINT: optionalString,
  MODEL_NAME: optionalString,
  MODEL_API_KEY: optionalString,

  // 搜索
  SEARCH_PROVIDER: optionalString,
  TAVILY_API_KEY: optionalString,

  // 邮件
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_TLS_MODE: z.enum(["implicit", "explicit", "none"]).default("explicit"),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  MAIL_FROM: optionalString,
  MAIL_TO: optionalString,

  // 展示模式（docs/demo-mode.md）。DEMO_URL 配在正式实例上：登录页出现“进入演示模式”入口，指向演示实例。
  DEMO_URL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.url().optional()),
  // 以下只在演示实例上配置。DEMO_MODE=1 时免登录、只认带演示标记的合成数据库。
  DEMO_MODE: z.preprocess((v) => v === true || v === "1" || v === "true", z.boolean()).default(false),
  // 全站每日模型/搜索调用硬上限：访客改不了，设置页与对话里调高也不会超过它
  DEMO_DAILY_MODEL_CALLS: numberWithDefault(0, 1000, 300),
  DEMO_DAILY_SEARCH_CALLS: numberWithDefault(0, 1000, 20),
  // 每天几点（实例时区）把数据恢复成初始示例
  DEMO_RESET_HOUR: numberWithDefault(0, 23, 4),
});

export type AppConfig = z.infer<typeof configSchema>;

export type IntegrationStatus =
  | { state: "configured" }
  | { state: "not_configured" }
  | { state: "error"; detail: string };

export type IntegrationStatusMap = {
  model: IntegrationStatus;
  search: IntegrationStatus;
  smtp: IntegrationStatus;
};

function readEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

let cached: AppConfig | null = null;

/** 进程内缓存解析结果；测试可调用 resetConfigCache() */
export function getConfig(): AppConfig {
  if (!cached) {
    cached = configSchema.parse(readEnv());
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

/** 判断各外部集成是否可用；不暴露任何 secret */
export function getIntegrationStatus(cfg: AppConfig = getConfig()): IntegrationStatusMap {
  let model: IntegrationStatus;
  if (!cfg.MODEL_PROTOCOL) {
    model = { state: "not_configured" };
  } else if (cfg.MODEL_PROTOCOL === "fake") {
    // 本地 fixture：不需要端点与 key；UI 需另外标识"示例数据"
    model = { state: "configured" };
  } else if (!SUPPORTED_MODEL_PROTOCOLS.includes(cfg.MODEL_PROTOCOL)) {
    model = { state: "error", detail: "不支持的模型协议（目前仅 openai-chat）" };
  } else if (!(cfg.MODEL_ENDPOINT && cfg.MODEL_API_KEY && cfg.MODEL_NAME)) {
    model = { state: "error", detail: "缺少 MODEL_ENDPOINT / MODEL_NAME / MODEL_API_KEY" };
  } else {
    model = { state: "configured" };
  }

  let search: IntegrationStatus;
  if (!cfg.SEARCH_PROVIDER) search = { state: "not_configured" };
  else if (cfg.SEARCH_PROVIDER === "fake") search = { state: "configured" };
  else if (cfg.SEARCH_PROVIDER !== "tavily")
    search = { state: "error", detail: "不支持的搜索 provider（目前仅 tavily）" };
  else if (!cfg.TAVILY_API_KEY)
    search = { state: "error", detail: "搜索 provider 已指定但缺少 TAVILY_API_KEY" };
  else search = { state: "configured" };

  const smtpReady = Boolean(
    cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASSWORD && cfg.MAIL_FROM && cfg.MAIL_TO,
  );
  const smtp: IntegrationStatus = smtpReady
    ? { state: "configured" }
    : { state: "not_configured" };

  return { model, search, smtp };
}

/**
 * 实际接通的真实模型协议（计划第 1 节：只接通一种）。T5 选定 OpenAI 兼容 chat completions。
 * "fake" 不在此列：它只用于本地 fixture，由 FIXTURE 模式显式启用，不冒充真实模型。
 */
export const SUPPORTED_MODEL_PROTOCOLS: string[] = ["openai-chat"];
