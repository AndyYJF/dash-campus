import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { resourceCreateSchema } from "@/contracts/records";
import { createResource, listResources } from "@/repositories/resources";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { const auth=requireOwner(request);if(!auth.ok)return auth.response;return NextResponse.json({resources:listResources(new URL(request.url).searchParams.get("includeArchived")==="true")}); }
export async function POST(request: NextRequest) {
 const auth=requireOwner(request);if(!auth.ok)return auth.response;const raw=await request.text(),json=parseJson(raw);if(!json.ok)return json.response;
 const p=resourceCreateSchema.safeParse(json.value);if(!p.success)return errorResponse("VALIDATION","资料输入不合法",422,p.error.issues);
 return runIdempotent(request,raw,{actorScope:`owner:${auth.session.ownerId}`,route:"resources",execute:()=>{const resource=createResource(p.data);return {statusCode:201,body:{resource},resourceType:"resource",resourceId:resource.id};}});
}
