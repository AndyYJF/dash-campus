import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { handleIdempotentCreate } from "@/workflows/http";
import { getSource, createSource } from "@/repositories/inbox";
import { importVerifiedNotice } from "@/workflows/inbox";
import { extractionFor } from "@/workflows/notice-extraction";
export const dynamic = "force-dynamic";
const schema = z.object({ text: z.string().trim().min(1).max(50000), sourceUrl: z.url().refine((url) => /^https?:\/\//.test(url)).optional(), occurredAt: z.iso.datetime({ offset: true }) });
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  return handleIdempotentCreate(request, { actorScope: `owner:${auth.session.ownerId}`, route: "inbox.manual", schema, resourceType: "inbox_message", execute: (input) => {
    if (!getSource("manual")) createSource("manual", "手工录入");
    const result = importVerifiedNotice({ schemaVersion: 1, source: "manual", externalId: crypto.randomUUID(), revisionKey: "r1", revisionOrder: 1, ...input });
    if (!result.ok) throw new Error("手工录入失败");
    return { id: result.messageId, messageId: result.messageId, extraction: extractionFor(result.revisionId) };
  } });
}
