import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { listAvailabilityBlocks, listFixedEvents } from "@/domain/workload";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { bumpPlanningRevision } from "@/repositories/proposals";

export const dynamic = "force-dynamic";

const timeRe = /^\d{2}:\d{2}$/;
const availabilitySchema = z.object({
  title: z.string().max(100).default(""),
  weekday: z.number().int().min(1).max(7),
  localStart: z.string().regex(timeRe),
  localEnd: z.string().regex(timeRe),
  timezone: z.string().min(1),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const fixedEventSchema = availabilitySchema.extend({
  title: z.string().min(1).max(200),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function writeRow(table: "availability_blocks" | "fixed_events", data: Record<string, unknown>): string {
  const db = getDb();
  const id = crypto.randomUUID();
  const cols: Record<string, unknown> =
    table === "fixed_events"
      ? { ...data, event_date: data.eventDate ?? null }
      : data;
  delete cols.eventDate;
  for (const k of Object.keys(cols)) {
    if (cols[k] === undefined) delete cols[k];
  }
  const keys = Object.keys(cols).map((k) =>
    k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  );
  db.prepare(
    `INSERT INTO ${table} (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
  ).run(id, ...Object.values(cols));
  return id;
}

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    availabilityBlocks: listAvailabilityBlocks(),
    fixedEvents: listFixedEvents(),
  });
}

const endAfterStart = (v: { localStart: string; localEnd: string }) => v.localStart < v.localEnd;

/**
 * POST ?kind=availability|fixed-event —— 创建要求 Idempotency-Key；
 * 写入与 planningRevision 递增在同一事务（F10）。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "availability" && kind !== "fixed-event") {
    return errorResponse("VALIDATION", "kind 必须是 availability 或 fixed-event", 422);
  }
  const rawBody = await request.text();
  const json = parseJson(rawBody);
  if (!json.ok) return json.response;
  const refined = { message: "结束时间必须晚于开始时间" };
  const parsed =
    kind === "availability"
      ? availabilitySchema.refine(endAfterStart, refined).safeParse(json.value)
      : fixedEventSchema.refine(endAfterStart, refined).safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return runIdempotent(request, rawBody, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `availability.${kind}`,
    execute: () => {
      const id =
        kind === "availability"
          ? writeRow("availability_blocks", { ...parsed.data, eventDate: undefined })
          : writeRow("fixed_events", { ...parsed.data });
      bumpPlanningRevision();
      return { statusCode: 201, body: { id }, resourceType: kind, resourceId: id };
    },
  });
}
