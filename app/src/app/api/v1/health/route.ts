import { NextResponse } from "next/server";
import { getSchemaVersion } from "@/repositories/db";

export const dynamic = "force-dynamic";

export function GET() {
  let dbState: "ok" | "error";
  let schemaVersion: number | null = null;
  let dbError: string | null = null;
  try {
    schemaVersion = getSchemaVersion();
    dbState = schemaVersion === null ? "error" : "ok";
  } catch (e) {
    dbState = "error";
    dbError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json(
    {
      ok: dbState === "ok",
      service: "dash-campus",
      db: dbState,
      schemaVersion,
      ...(dbError ? { dbError } : {}),
      asOf: new Date().toISOString(),
    },
    { status: dbState === "ok" ? 200 : 503 },
  );
}
