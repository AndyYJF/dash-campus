import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { intakeCreateSchema } from "@/contracts/intake";
import { receiveIntake } from "@/workflows/intake";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/intakes（MASTER-PLAN §8）：
 * 幂等持久接收 → 202 立即返回；处理异步进行，结果走 GET /api/v2/intakes/:id。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = intakeCreateSchema.safeParse(json.value);
  if (!parsed.success) {
    return errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422);
  }
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.intakes.create",
    execute: () => {
      const r = receiveIntake({
        channel: "web",
        text: parsed.data.text,
        referenceDate: parsed.data.referenceDate,
      });
      return { statusCode: 202, body: { intakeId: r.intakeId, status: r.status }, resourceType: "intake", resourceId: r.intakeId };
    },
  });
}
