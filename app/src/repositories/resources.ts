import crypto from "node:crypto";
import { getDb } from "./db";
import { resourceCreateSchema } from "@/contracts/records";
import type { z } from "zod";
import { HttpError } from "@/workflows/http";

type ResourceInput = z.infer<typeof resourceCreateSchema>;
export type ResourceRow = ResourceInput & { id: string; version: number; archivedAt: string | null; createdAt: string; updatedAt: string };
const columns = { kind: "kind", title: "title", body: "body", url: "url", sourceYear: "source_year", sourceKind: "source_kind" } as const;
function map(row: Record<string,unknown>): ResourceRow { return { id: row.id as string,kind: row.kind as ResourceRow["kind"],title: row.title as string,body: row.body as string,url: row.url as string|null,sourceYear: row.source_year as number|null,sourceKind: row.source_kind as ResourceRow["sourceKind"],version: row.version as number,archivedAt: row.archived_at as string|null,createdAt: row.created_at as string,updatedAt: row.updated_at as string }; }
export function getResource(id: string): ResourceRow | null { const row = getDb().prepare("SELECT * FROM resources WHERE id=?").get(id) as Record<string,unknown>|undefined;return row?map(row):null; }
export function listResources(includeArchived = false): ResourceRow[] { return (getDb().prepare(`SELECT * FROM resources ${includeArchived?"":"WHERE archived_at IS NULL"} ORDER BY updated_at DESC,id`).all() as Array<Record<string,unknown>>).map(map); }
function snapshot(resource: ResourceRow) { return Object.fromEntries(Object.keys(columns).map((key) => [key, resource[key as keyof ResourceInput]])); }
function saveRevision(id: string) {
 const r=getResource(id)!, text=JSON.stringify({...snapshot(r),archivedAt:r.archivedAt});
 getDb().prepare("INSERT INTO resource_revisions(resource_id,version,snapshot_json,content_hash,created_at) VALUES(?,?,?,?,?)").run(id,r.version,text,crypto.createHash("sha256").update(text).digest("hex"),r.updatedAt);
}
export function resourceRevisions(id: string) {return (getDb().prepare("SELECT version,snapshot_json,content_hash,created_at FROM resource_revisions WHERE resource_id=? ORDER BY version DESC").all(id) as Array<{version:number;snapshot_json:string;content_hash:string;created_at:string}>).map((r)=>({version:r.version,snapshot:JSON.parse(r.snapshot_json),contentHash:r.content_hash,createdAt:r.created_at}));}
export function createResource(input: ResourceInput): ResourceRow {
 return getDb().transaction(()=>{const id=crypto.randomUUID(),at=new Date().toISOString();getDb().prepare("INSERT INTO resources(id,kind,title,body,url,source_year,source_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,input.kind,input.title,input.body,input.url,input.sourceYear,input.sourceKind,at,at);saveRevision(id);return getResource(id)!;}).immediate();
}
export function updateResource(id:string,patch:Partial<ResourceInput>,expectedVersion:number,archive=false):ResourceRow|"not_found"|"conflict" {
 return getDb().transaction(()=>{
  const current=getResource(id);if(!current||current.archivedAt)return "not_found" as const;if(current.version!==expectedVersion)return "conflict" as const;
  const parsed=resourceCreateSchema.safeParse({...current,...patch});if(!parsed.success)throw new HttpError(422,"VALIDATION","链接资料需有效URL，文本资料需非空正文");
  const next=parsed.data;if(!archive&&Object.keys(columns).every((k)=>current[k as keyof ResourceInput]===next[k as keyof ResourceInput]))return current;
  const at=new Date().toISOString();getDb().prepare("UPDATE resources SET kind=?,title=?,body=?,url=?,source_year=?,source_kind=?,version=version+1,updated_at=?,archived_at=? WHERE id=? AND version=?").run(next.kind,next.title,next.body,next.url,next.sourceYear,next.sourceKind,at,archive?at:null,id,expectedVersion);
  saveRevision(id);return getResource(id)!;
 }).immediate();
}
