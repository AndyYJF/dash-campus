import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { HttpError } from "@/workflows/http";
import { parseIcs, type IcsEvent, type IcsUnsupported } from "@/domain/ics";
import { instanceTimezone } from "@/domain/time";
import { parseCsv, parseXlsx, sheetsToText } from "@/domain/spreadsheet";
import { downscale, encodePng, type RawImage } from "@/domain/png";
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
  | { kind: "ics"; events: IcsEvent[]; skippedRecurring: number; unsupported: IcsUnsupported[] }
  | { kind: "text"; text: string; locator?: string; sourceKind?: string }
  | { kind: "image"; dataUrl: string }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "unsupported"; error: string };

/** 附件 → 处理产物（确定性部分；image 交给模型 vision） */
export function extractAttachment(att: AttachmentRow): AttachmentOutcome {
  const blob = blobBytes(att.blobHash);
  if (!blob) return { kind: "unsupported", error: "附件内容缺失" };
  const mt = att.mediaType;
  if (mt === "text/calendar" || att.originalName.endsWith(".ics")) {
    const parsed = parseIcs(blob.bytes.toString("utf8"), instanceTimezone());
    if (!parsed.events.length) {
      const why = parsed.unsupported.slice(0, 3).map((u) => `「${u.title}」${u.reason}`).join("；");
      return { kind: "unsupported", error: `ICS 里没有能导入的事件${why ? `：${why}` : ""}。原件已保留` };
    }
    setExtraction(att.id, "done");
    return { kind: "ics", events: parsed.events, skippedRecurring: parsed.skippedRecurring, unsupported: parsed.unsupported };
  }
  // 表格：本地读出单元格和行列位置；不执行公式/宏
  const isCsv = mt === "text/csv" || /\.csv$/i.test(att.originalName);
  const isXlsx = mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || /\.xls[xm]$/i.test(att.originalName);
  if (isCsv || isXlsx) {
    const parsed = isCsv ? parseCsv(new Uint8Array(blob.bytes), att.originalName.replace(/\.csv$/i, "")) : parseXlsx(new Uint8Array(blob.bytes));
    if (!parsed.ok) {
      setExtraction(att.id, "unsupported");
      return { kind: "unsupported", error: `${parsed.error}。原件已保留` };
    }
    setExtraction(att.id, "done");
    return { kind: "text", text: `附件「${att.originalName}」的表格内容（带行号和列字母）：\n${sheetsToText(parsed.sheets, parsed.notes)}`.slice(0, 100_000), locator: parsed.sheets.map((s) => `${s.name}!A${s.firstRow}:${s.firstRow + s.rows.length - 1}`).join("; "), sourceKind: isCsv ? "csv" : "xlsx" };
  }
  if (mt === "application/vnd.ms-excel" || /\.xls$/i.test(att.originalName)) {
    setExtraction(att.id, "unsupported");
    return { kind: "unsupported", error: "旧版 .xls 表格读不了：请在表格软件里另存为 .xlsx 或 .csv 再发。原件已保留" };
  }
  if (mt.startsWith("text/") || /\.(txt|md)$/i.test(att.originalName)) {
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

export const MAX_PDF_PAGES = 30;
/** 扫描页图像长边上限：够看清课表文字，又不至于把一页发成几兆 */
const SCAN_MAX_SIDE = 1800;

export type PdfExtraction = {
  pages: number;
  /** 有文字层的页：逐页保留页码 */
  textPages: Array<{ page: number; text: string }>;
  /** 没有文字层的页（扫描件）：取页面里最大的那张图，交给图片识别 */
  scannedPages: Array<{ page: number; dataUrl: string }>;
  /** 既没有文字、也取不出图像的页 */
  unreadablePages: number[];
  skippedPages: number;
};

/**
 * PDF 逐页提取（MASTER-PLAN §3.1）：可复制文字本地取；扫描页走同一条图片识别管线并保留页码。
 * 不读脚本/表单动作。超过 30 页只处理前 30 页并说明。解析失败返回 null。
 */
export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction | null> {
  try {
    const { getDocumentProxy, extractText, extractImages } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const total = pdf.numPages;
    const limit = Math.min(total, MAX_PDF_PAGES);
    const texts = (await extractText(pdf, { mergePages: false })).text as string[];
    const out: PdfExtraction = { pages: total, textPages: [], scannedPages: [], unreadablePages: [], skippedPages: total - limit };
    for (let page = 1; page <= limit; page++) {
      const text = (texts[page - 1] ?? "").trim();
      if (text.length >= 4) {
        out.textPages.push({ page, text });
        continue;
      }
      let best: RawImage | null = null;
      try {
        for (const img of await extractImages(pdf, page)) {
          if (!best || img.width * img.height > best.width * best.height) best = { data: img.data, width: img.width, height: img.height, channels: img.channels };
        }
      } catch {
        best = null;
      }
      // 太小的图是图标/印章，不是页面扫描
      if (!best || best.width < 200 || best.height < 200) {
        out.unreadablePages.push(page);
        continue;
      }
      out.scannedPages.push({ page, dataUrl: `data:image/png;base64,${encodePng(downscale(best, SCAN_MAX_SIDE)).toString("base64")}` });
    }
    return out;
  } catch {
    return null;
  }
}

/** 标记附件提取完成（PDF 异步路径用） */
export function markExtractionDone(id: string): void {
  setExtraction(id, "done");
}

/** 附件的本地提取结果存为证据（带定位：页码或工作表行范围）；同一附件同一定位只存一次 */
export function recordFileDocument(intakeId: string, sourceKind: string, fileName: string, locator: string | null, text: string): void {
  const db = getDb();
  const loc = locator ? `${fileName}#${locator}` : fileName;
  if (db.prepare(`SELECT 1 FROM extracted_documents WHERE intake_id = ? AND source_kind = ? AND locator = ?`).get(intakeId, sourceKind, loc)) return;
  db.prepare(`INSERT INTO extracted_documents (id, intake_id, source_kind, extractor_version, content_text, content_hash, locator, status, created_at) VALUES (?, ?, ?, 'file-v1', ?, ?, ?, 'done', ?)`).run(crypto.randomUUID(), intakeId, sourceKind, text, crypto.createHash("sha256").update(text).digest("hex"), loc, new Date().toISOString());
}

/** 保存 URL 抓取结果为提取证据 + 返回正文 */
export function recordUrlDocument(intakeId: string, url: string, text: string): void {
  getDb()
    .prepare(`INSERT INTO extracted_documents (id, intake_id, source_kind, extractor_version, content_text, content_hash, locator, status, created_at) VALUES (?, ?, 'url', 'url-v1', ?, ?, ?, 'done', ?)`)
    .run(crypto.randomUUID(), intakeId, text, crypto.createHash("sha256").update(text).digest("hex"), url, new Date().toISOString());
}

/** 网页图片也使用附件 blob 保存；重试复用原始字节，且纳入同一份材料的文件/尺寸限额。 */
export function saveUrlImage(intakeId: string, pageUrl: string, imageUrl: string, dataUrl: string): boolean {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(`SELECT 1 FROM intake_attachments WHERE intake_id = ? AND blob_hash = ?`).get(intakeId, hash);
    const usage = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM intake_attachments WHERE intake_id = ?`).get(intakeId) as { count: number; bytes: number };
    if (!existing && (usage.count >= MAX_FILES || usage.bytes + bytes.length > MAX_TOTAL_BYTES || bytes.length > MAX_FILE_BYTES)) return false;
    saveAttachments(intakeId, [{ name: `网页图片-${hash.slice(0, 12)}.${match[1]!.split("/")[1]}`, mediaType: match[1]!, bytes }]);
    recordFileDocument(intakeId, "url-image", pageUrl, imageUrl, JSON.stringify({ imageUrl, blobHash: hash }));
    return true;
  })();
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
      // 没导入的事件逐条说明原因（全天/跨夜/不支持的重复规则），不静默丢
      payload: { events: outcome.events, skippedRecurring: outcome.skippedRecurring, file: att.originalName, unclear: outcome.unsupported.map((u) => `「${u.title}」${u.reason}`) },
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
