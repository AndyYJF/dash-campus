import { NextResponse } from "next/server";
import { getIntegrationStatus } from "@/config";

export const dynamic = "force-dynamic";

/** 集成状态：只暴露 configured/not_configured/error，绝不返回 secret */
export function GET() {
  return NextResponse.json({ integrations: getIntegrationStatus() });
}
