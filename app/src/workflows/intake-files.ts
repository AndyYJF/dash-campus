import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { HttpError } from "@/workflows/http";
import { parseIcs, type IcsEvent } from "@/domain/ics";
import { createItem, updateItem } from "@/repositories/intakes";

/**
 * 附件与 URL 处理（MASTER-PLAN §3/§4.1）：
 * 限额 10 文件 / 单件 10MiB / 共 30MiB；blob 按 hash 去重；PDF/XLSX 暂不支持的明确失败不静默。
 * 文件字节在路由异步读出后传入（同步事务内不做 IO）；URL 抓取在 worker 内（接收时不发外部请求）。
 */

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_URL_BYTES = 1024 * 1024;

export type IncomingFile = { name: string; mediaType: string; bytes: Uint8Array };

/** 校验 + 保存附件（同步，路由幂等事务内调用；超限抛 HttpError 回滚，不烧幂等键） */
export function saveAttachments(intakeId: string, files: IncomingFile[]): void {
  if (files.length > MAX_FILES) throw new HttpError(422, "VALIDATION", `一次最多 ${MAX_FILES} 个文件（收到 ${files.length} 个）`);
  const total = files.reduce((a, f) => a + f.bytes.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `附件合计不能超过 30MiB（本次 ${(total / 1048576).toFixed(1)}MiB）`);
  const db = getDb();
  const now = new Date().toISOString();
  for (const f of files) {
    if (f.bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `单个文件不能超过 10MiB：${f.name}`);
    const hash = crypto.createHash("sha256").update(f.bytes).digest("hex");
    db.prepare(`INSERT OR IGNORE INTO intake_blobs (hash, media_type, size_bytes, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      hash,
      f.mediaType || "application/octet-stream",
      f.bytes.length,
      Buffer.from(f.bytes),
      now,
    );
    db.prepare(
      `INSERT INTO intake_attachments (id, intake_id, blob_hash, media_type, size_bytes, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (intake_id, blob_hash) DO NOTHING`,
    ).run(crypto.randomUUID(), intakeId, hash, f.mediaType || "application/octet-stream", f.bytes.length, f.name.slice(0, 200), now);
  }
}

export type AttachmentRow = { id: string; blobHash: string; mediaType: string; originalName: string; extractionState: string };

export function listAttachments(intakeId: string): AttachmentRow[] {
  const rows = getDb().prepare(`SELECT * FROM intake_attachments WHERE intake_id = ? ORDER BY created_at`).all(intakeId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    blobHash: r.blob_hash as string,
    mediaType: r.media_type as string,
    originalName: r.original_name as string,
    extractionState: r.extraction_state as string,
  }));
}

export function blobBytes(hash: string): { bytes: Buffer; mediaType: string } | null {
  const r = getDb().prepare(`SELECT content, media_type FROM intake_blobs WHERE hash = ?`).get(hash) as { content: Buffer; media_type: string } | undefined;
  return r ? { bytes: r.content, mediaType: r.media_type } : null;
}

function setExtraction(id: string, state: string): void {
  getDb().prepare(`UPDATE intake_attachments SET extraction_state = ? WHERE id = ?`).run(state, id);
}

export type AttachmentOutcome =
  | { kind: "ics"; events: IcsEvent[]; skippedRecurring: number }
  | { kind: "text"; text: string }
  | { kind: "image"; dataUrl: string }
  | { kind: "unsupported"; error: string };

/** 附件 → 处理产物（确定性部分；image 交给模型 vision） */
export function extractAttachment(att: AttachmentRow): AttachmentOutcome {
  const blob = blobBytes(att.blobHash);
  if (!blob) return { kind: "unsupported", error: "附件内容缺失" };
  const mt = att.mediaType;
  if (mt === "text/calendar" || att.originalName.endsWith(".ics")) {
    const parsed = parseIcs(blob.bytes.toString("utf8"));
    if (!parsed.events.length) return { kind: "unsupported", error: "ICS 里没有可识别的一次性事件（RRULE 重复事件暂不支持）" };
    setExtraction(att.id, "done");
    return { kind: "ics", events: parsed.events, skippedRecurring: parsed.skippedRecurring };
  }
  if (mt.startsWith("text/") || /\.(csv|txt|md)$/i.test(att.originalName)) {
    setExtraction(att.id, "done");
    return { kind: "text", text: blob.bytes.toString("utf8").slice(0, 100_000) };
  }
  if (mt.startsWith("image/")) {
    setExtraction(att.id, "done");
    return { kind: "image", dataUrl: `data:${mt};base64,${blob.bytes.toString("base64")}` };
  }
  setExtraction(att.id, "unsupported");
  const label = mt === "application/pdf" || /\.pdf$/i.test(att.originalName) ? "PDF" : `类型 ${mt}`;
  return { kind: "unsupported", error: `${label} 暂不支持：已保留原件，可先复制其中的文字投递` };
}

/** 保存 URL 抓取结果为提取证据 + 返回正文 */
export function recordUrlDocument(intakeId: string, url: string, text: string): void {
  getDb()
    .prepare(`INSERT INTO extracted_documents (id, intake_id, source_kind, extractor_version, content_text, content_hash, locator, status, created_at) VALUES (?, ?, 'url', 'url-v1', ?, ?, ?, 'done', ?)`)
    .run(crypto.randomUUID(), intakeId, text, crypto.createHash("sha256").update(text).digest("hex"), url, new Date().toISOString());
}

/** 抓 URL 正文：data: 直接解析；http(s) 10s 超时 + 1MiB 上限 + 去标签 */
export async function fetchUrlText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) return { ok: false, error: "data URL 不合法" };
    return { ok: true, text: decodeURIComponent(url.slice(comma + 1)).slice(0, 100_000) };
  }
  if (!/^https?:\/\//.test(url)) return { ok: false, error: "只支持 http(s) 链接" };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (!res.ok) return { ok: false, error: `抓取失败 HTTP ${res.status}` };
    const raw = (await res.text()).slice(0, MAX_URL_BYTES);
    return { ok: true, text: raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100_000) };
  } catch (e) {
    return { ok: false, error: `抓取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 附件处理成事项：ics → 确定性 ready 事项；text → 并入分类文本；image → vision 分类；unsupported → 失败事项 */
export function materializeAttachment(intakeId: string, att: AttachmentRow, outcome: AttachmentOutcome): void {
  if (outcome.kind === "ics") {
    createItem({
      intakeId,
      stableItemKey: `ics-${att.id.slice(0, 8)}`,
      kind: "ics",
      payload: { events: outcome.events, skippedRecurring: outcome.skippedRecurring, file: att.originalName },
    });
    return;
  }
  if (outcome.kind === "unsupported") {
    const { item } = createItem({ intakeId, stableItemKey: `file-${att.id.slice(0, 8)}`, kind: "note", payload: { file: att.originalName, retryable: false } });
    updateItem(item.id, { state: "failed", evidence: { error: outcome.error } });
    return;
  }
  // text/image 由管线并入分类上下文
}
