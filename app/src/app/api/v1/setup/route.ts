import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/config";
import { hashPassword } from "@/domain/password";
import { createOwner, hasOwner } from "@/domain/session";

export const dynamic = "force-dynamic";

/** 常量时间比较（长度不同直接不等；长度本身不是秘密） */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const setupSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "密码至少 8 位"),
});

/** 一次性初始化：SETUP_TOKEN 验证 + 创建唯一主人；初始化后不再生效 */
export async function POST(request: NextRequest) {
  const cfg = getConfig();
  if (!cfg.SETUP_TOKEN) {
    return NextResponse.json(
      { error: { code: "INTEGRATION_UNAVAILABLE", message: "未配置 SETUP_TOKEN" } },
      { status: 503 },
    );
  }
  if (hasOwner()) {
    return NextResponse.json(
      { error: { code: "ALREADY_SET_UP", message: "实例已初始化" } },
      { status: 409 },
    );
  }
  const parsed = setupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "输入不合法", details: parsed.error.issues } },
      { status: 422 },
    );
  }
  // 复制粘贴常带进首尾空白或换行；也容忍整行 "SETUP_TOKEN=xxx" 被粘进来
  const given = parsed.data.token.trim().replace(/^SETUP_TOKEN=/, "").trim();
  if (!sameSecret(given, cfg.SETUP_TOKEN)) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: `SETUP_TOKEN 不正确（收到 ${given.length} 个字符，应为 ${cfg.SETUP_TOKEN.length} 个）。只粘贴等号后面的部分`,
        },
      },
      { status: 403 },
    );
  }
  createOwner(hashPassword(parsed.data.password));
  return NextResponse.json({ ok: true }, { status: 201 });
}
