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
const MAX_URL_BYTES = 5 * 1024 * 1024;

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
  | { kind: "pdf"; bytes: Uint8Array }
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
  if (mt === "application/pdf" || /\.pdf$/i.test(att.originalName)) {
    return { kind: "pdf", bytes: new Uint8Array(blob.bytes) };
  }
  setExtraction(att.id, "unsupported");
  return { kind: "unsupported", error: `类型 ${mt} 暂不支持：已保留原件，可先复制其中的文字投递` };
}

/** PDF 文本层提取（unpdf，A14）。无文本层（扫描件）或解析失败返回 null——调用方提示改走图片投递 */
export async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText } = await import("unpdf");
    const r = await extractText(bytes);
    const text = r.text.join("\n").trim();
    return text.length >= 4 ? text.slice(0, 100_000) : null;
  } catch {
    return null;
  }
}

/** 标记附件提取完成（PDF 异步路径用） */
export function markExtractionDone(id: string): void {
  setExtraction(id, "done");
}

/** 保存 URL 抓取结果为提取证据 + 返回正文 */
export function recordUrlDocument(intakeId: string, url: string, text: string): void {
  getDb()
    .prepare(`INSERT INTO extracted_documents (id, intake_id, source_kind, extractor_version, content_text, content_hash, locator, status, created_at) VALUES (?, ?, 'url', 'url-v1', ?, ?, ?, 'done', ?)`)
    .run(crypto.randomUUID(), intakeId, text, crypto.createHash("sha256").update(text).digest("hex"), url, new Date().toISOString());
}

const PRIVATE_HOSTNAMES = new Set(["localhost", "::1", "0.0.0.0", "[::1]"]);
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 公开网页常拒绝无 UA 的请求；只带通用浏览器 UA，不带任何 cookie 或主机环境凭证 */
const FETCH_HEADERS = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

function isPrivateIpv4(h: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateIpv6(h: string): boolean {
  const x = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (!x.includes(":")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
}

/** A16 SSRF 防护（字面量）：私网/环回/链路本地/云元数据地址一律拒绝 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return PRIVATE_HOSTNAMES.has(h) || isPrivateIpv4(h) || isPrivateIpv6(h);
}

/** 域名解析后的每个地址也要校验：公开域名指向私网（DNS 重绑定）同样拒绝 */
async function resolvesToPrivate(host: string): Promise<boolean> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false; // 字面量已在 isPrivateHost 判过
  try {
    const { lookup } = await import("node:dns/promises");
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateIpv4(a.address) || isPrivateIpv6(a.address));
  } catch {
    return false; // 解析失败交给后面的 fetch 报错
  }
}

/** 流式读取并在上限处截断：不先把整个响应读进内存再限额 */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { bytes: out, truncated };
}

type RawFetch = { ok: true; res: Response; finalUrl: string } | { ok: false; error: string; status?: number };

/** 逐跳校验的受限抓取：最多 5 次重定向、15 秒，每一跳都重新校验目标地址 */
async function guardedFetch(url: string): Promise<RawFetch> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:\/\//.test(current)) return { ok: false, error: "只支持 http(s) 链接" };
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return { ok: false, error: "URL 不合法" };
    }
    if (isPrivateHost(host) || (await resolvesToPrivate(host))) return { ok: false, error: `不允许抓取私网或本机地址：${host}` };
    try {
      const res = await fetch(current, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual", headers: FETCH_HEADERS });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, error: "重定向无目标" };
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return { ok: false, error: `抓取失败 HTTP ${res.status}`, status: res.status };
      return { ok: true, res, finalUrl: current };
    } catch (e) {
      return { ok: false, error: `抓取失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: false, error: "重定向次数过多" };
}

function htmlToPlain(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 正文里的内容图片（校历常常只有图片）：同站、非图标，最多 4 张 */
function contentImages(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const host = new URL(baseUrl).hostname;
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let abs: string;
    try {
      abs = new URL(m[1]!, baseUrl).toString();
    } catch {
      continue;
    }
    if (new URL(abs).hostname !== host) continue;
    if (/icon|logo|search|menu|close|banner|qrcode|ewm|\.gif(\?|$)/i.test(abs)) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  // 站点装饰图通常在页头页尾重复出现在 /images/ 下；正文上传的图在 /__local/、/upload 等路径，优先取后者
  const uploaded = out.filter((u) => /__local|upload|attach|ueditor|\/\d{4}\//i.test(u));
  return (uploaded.length ? uploaded : out).slice(0, 4);
}

export type UrlFetch = { ok: true; text: string; images: string[]; finalUrl: string } | { ok: false; error: string; status?: number };

/** 抓 URL：data: 直接解析；http(s) 受限抓取 + 5MiB 上限 + 去标签；同时返回正文内容图片地址 */
export async function fetchUrl(url: string): Promise<UrlFetch> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) return { ok: false, error: "data URL 不合法" };
    return { ok: true, text: decodeURIComponent(url.slice(comma + 1)).slice(0, 100_000), images: [], finalUrl: url };
  }
  const r = await guardedFetch(url);
  if (!r.ok) return r;
  const { bytes } = await readCapped(r.res, MAX_URL_BYTES);
  const html = new TextDecoder("utf-8").decode(bytes);
  return { ok: true, text: htmlToPlain(html).slice(0, 100_000), images: contentImages(html, r.finalUrl), finalUrl: r.finalUrl };
}

/** 兼容旧调用：只要正文 */
export async function fetchUrlText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await fetchUrl(url);
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error };
}

/** 抓一张网页内容图片成 data URL（给视觉提取用）；超限或不是图片就放弃，不影响正文 */
export async function fetchImageDataUrl(url: string): Promise<string | null> {
  const r = await guardedFetch(url);
  if (!r.ok) return null;
  const type = (r.res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!/^image\/(png|jpe?g|webp)$/.test(type)) return null;
  const { bytes, truncated } = await readCapped(r.res, MAX_IMAGE_BYTES);
  if (truncated || bytes.length < 8 * 1024) return null; // 太小的多半是装饰图
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
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
