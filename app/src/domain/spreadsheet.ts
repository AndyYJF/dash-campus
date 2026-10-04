import zlib from "node:zlib";

/**
 * 表格本地解析（MASTER-PLAN §3.1）：`.xlsx` / `.csv` 提取单元格与行列位置。
 * 不执行公式和宏：公式只取文件里缓存的结果，没有缓存值标“未知”；宏（vbaProject）不读。
 * 限额：最多 5 个工作表、每表 5000 行、解压总量 64MiB——超出时说明处理到哪里，不静默截断。
 * 旧版 `.xls`（二进制）不在支持范围，调用方如实说明。
 */

export type Sheet = { name: string; rows: string[][]; firstRow: number; truncatedRows: number };
export type SpreadsheetResult = { ok: true; sheets: Sheet[]; notes: string[] } | { ok: false; error: string };

export const MAX_SHEETS = 5;
export const MAX_ROWS = 5000;
const MAX_INFLATED = 64 * 1024 * 1024;
const MAX_COLS = 200;

// ---------- CSV ----------

/** 编码：UTF-8（含 BOM）优先；不是合法 UTF-8 时按 GB18030（兼容 GBK）读并标记 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: "utf-8" | "gb18030" | "utf-16le" } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("gb18030").decode(bytes), encoding: "gb18030" };
  }
}

export function parseCsv(bytes: Uint8Array, name = "CSV"): SpreadsheetResult {
  const { text, encoding } = decodeText(bytes);
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  // 分隔符：取首行里出现最多的（逗号/分号/制表符）
  const delim = ([",", ";", "\t"] as const).map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let total = 0;
  const pushRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) {
      total++;
      if (rows.length < MAX_ROWS) rows.push(row.slice(0, MAX_COLS).map((c) => c.trim()));
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length) pushRow();
  if (quoted) return { ok: false, error: "CSV 里有没闭合的引号，读不出完整的行列" };
  if (!rows.length) return { ok: false, error: "CSV 是空的" };
  const notes: string[] = [];
  if (encoding !== "utf-8") notes.push(`文件不是 UTF-8，已按 ${encoding === "gb18030" ? "GBK/GB18030" : "UTF-16"} 读取；如果出现乱码请另存为 UTF-8 再发`);
  if (total > MAX_ROWS) notes.push(`共 ${total} 行，只读了前 ${MAX_ROWS} 行；其余请分批发`);
  return { ok: true, sheets: [{ name, rows, firstRow: 1, truncatedRows: Math.max(0, total - MAX_ROWS) }], notes };
}

// ---------- XLSX（zip + XML，只读需要的部件） ----------

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number };

function readZip(buf: Buffer): Map<string, ZipEntry> | null {
  // 末尾找中央目录结束记录
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf: Buffer, e: ZipEntry, budget: { left: number }): string | null {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) {
    budget.left -= data.length;
    return budget.left < 0 ? null : data.toString("utf8");
  }
  if (e.method !== 8) return null;
  try {
    // 上限按剩余解压额度给：压缩炸弹在这里被截住
    const out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget.left) });
    budget.left -= out.length;
    return out.toString("utf8");
  } catch (e) {
    // 超出解压额度（压缩炸弹或确实太大）：记为额度用尽，调用方按超限说明
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") budget.left = -1;
    return null;
  }
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

/** 一个 <si> 或 <is> 里的文字：拼接所有 <t>（富文本分段），跳过拼音注音 <rPh> */
function richText(xml: string): string {
  const body = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]!);
  return out;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** 哪些单元格样式是日期/时间格式（序列号要换算，不当普通数字） */
function dateStyles(stylesXml: string | null): Array<"date" | "time" | "datetime" | null> {
  if (!stylesXml) return [];
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s+[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), unescapeXml(m[2]!));
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  return [...cellXfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    const hasDate = custom.has(id) ? /[yd]/i.test(code) || /m/i.test(code.replace(/h+[:：]?m+|m+[:：]?s+/gi, "")) : [14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 57, 58].includes(id);
    const hasTime = custom.has(id) ? /[hs]/i.test(code) : [18, 19, 20, 21, 32, 33, 34, 35, 45, 46, 47, 55, 56].includes(id);
    if (id === 22) return "datetime";
    if (!custom.has(id) && !BUILTIN_DATE_FMTS.has(id)) return null;
    return hasDate && hasTime ? "datetime" : hasDate ? "date" : hasTime ? "time" : null;
  });
}

/** Excel 序列号 → 文本（1900 日期系统；时间四舍五入到分钟） */
function serialToText(v: number, kind: "date" | "time" | "datetime"): string {
  const totalMinutes = Math.round(v * 1440);
  const days = Math.floor(totalMinutes / 1440);
  const minutes = totalMinutes - days * 1440;
  const hm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  if (kind === "time") return hm;
  const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
  return kind === "date" ? date : `${date} ${hm}`;
}

export function parseXlsx(bytes: Uint8Array): SpreadsheetResult {
  const buf = Buffer.from(bytes);
  const zip = readZip(buf);
  if (!zip) return { ok: false, error: "这个文件不是有效的 .xlsx（旧版 .xls 请在表格软件里另存为 .xlsx 或 .csv 再发）" };
  const budget = { left: MAX_INFLATED };
  const read = (name: string) => {
    const e = zip.get(name);
    return e ? inflateEntry(buf, e, budget) : null;
  };
  const workbook = read("xl/workbook.xml");
  if (!workbook) return { ok: false, error: "读不出工作簿结构（文件可能加了密码或已损坏）" };
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheetDefs = [...workbook.matchAll(/<sheet\s[^>]*>/g)].map((m) => ({ name: unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet"), rid: /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "", hidden: /state="(hidden|veryHidden)"/.test(m[0]) }));
  if (!sheetDefs.length) return { ok: false, error: "工作簿里没有工作表" };

  const sst = read("xl/sharedStrings.xml");
  const shared = sst ? [...sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => richText(m[1] ?? "")) : [];
  const styles = dateStyles(read("xl/styles.xml"));
  const notes: string[] = [];
  if ([...zip.keys()].some((k) => /vbaProject/i.test(k))) notes.push("文件带宏：宏没有被读取或执行");
  const visible = sheetDefs.filter((s) => !s.hidden);
  if (visible.length > MAX_SHEETS) notes.push(`共 ${visible.length} 个工作表，只读了前 ${MAX_SHEETS} 个（${visible.slice(MAX_SHEETS).map((s) => `「${s.name}」`).join("、")} 没读）；其余请分批发`);

  const sheets: Sheet[] = [];
  let unknownFormulas = 0;
  for (const def of visible.slice(0, MAX_SHEETS)) {
    const xml = read(targets.get(def.rid) ?? "");
    if (xml === null) {
      if (budget.left <= 0) return { ok: false, error: "表格解压后超过 64MiB：请拆成几份再发" };
      notes.push(`工作表「${def.name}」读不出来`);
      continue;
    }
    const rows: string[][] = [];
    let firstRow = 0;
    let total = 0;
    for (const rm of xml.matchAll(/<row\s([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNumber = Number(/\br="(\d+)"/.exec(rm[1]!)?.[1] ?? total + 1);
      const cells: string[] = [];
      for (const cm of rm[2]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]!;
        const inner = cm[2] ?? "";
        const col = colIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
        if (col < 0 || col >= MAX_COLS) continue;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const hasFormula = /<f[\s>/]/.test(inner);
        let value = "";
        if (type === "inlineStr") value = richText(inner);
        else if (raw === undefined) {
          if (hasFormula) {
            value = "（公式，文件里没有计算结果）";
            unknownFormulas++;
          }
        } else if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "b") value = raw === "1" ? "是" : "否";
        else if (type === "e") value = "（公式出错）";
        else if (type === "str") value = unescapeXml(raw);
        else {
          const style = styles[Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1)];
          const num = Number(raw);
          value = style && Number.isFinite(num) ? serialToText(num, style) : Number.isFinite(num) ? String(Number(num.toPrecision(15))) : unescapeXml(raw);
        }
        while (cells.length < col) cells.push("");
        cells[col] = value.replace(/\s*\r?\n\s*/g, " / ").trim();
      }
      if (!cells.some((c) => c !== "")) continue;
      total++;
      if (rows.length >= MAX_ROWS) continue;
      if (!rows.length) firstRow = rowNumber;
      // 行号按文件里的实际行：中间的空行补上，定位才对得上
      while (rows.length < rowNumber - firstRow && rows.length < MAX_ROWS) rows.push([]);
      if (rows.length < MAX_ROWS) rows.push(cells);
    }
    // 合并单元格：值只在左上角，其余位置标出指向，免得被当成空
    for (const mm of xml.matchAll(/<mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
      const [c1, r1, c2, r2] = [colIndex(mm[1]!), Number(mm[2]), colIndex(mm[3]!), Number(mm[4])];
      const v = rows[r1 - firstRow]?.[c1];
      if (!v) continue;
      for (let r = r1; r <= Math.min(r2, firstRow + rows.length - 1); r++) {
        for (let c = c1; c <= Math.min(c2, MAX_COLS - 1); c++) {
          if (r === r1 && c === c1) continue;
          const target = rows[r - firstRow];
          if (!target) continue;
          while (target.length < c) target.push("");
          if (!target[c]) target[c] = v;
        }
      }
    }
    if (total > MAX_ROWS) notes.push(`工作表「${def.name}」共 ${total} 行有内容，只读了前 ${MAX_ROWS} 行；其余请分批发`);
    if (rows.length) sheets.push({ name: def.name, rows, firstRow, truncatedRows: Math.max(0, total - MAX_ROWS) });
  }
  if (budget.left <= 0) return { ok: false, error: "表格解压后超过 64MiB：请拆成几份再发" };
  if (unknownFormulas) notes.push(`${unknownFormulas} 个单元格是公式且文件里没有保存计算结果：这些值按未知处理，没有替你计算`);
  if (!sheets.length) return { ok: false, error: "表格里没有内容" };
  return { ok: true, sheets, notes };
}

/** 渲染成带行号、列字母的文本：后续理解与取证都能说出“工作表/第几行/哪一列” */
export function sheetsToText(sheets: Sheet[], notes: string[] = []): string {
  const parts: string[] = [];
  for (const s of sheets) {
    const width = Math.max(0, ...s.rows.map((r) => r.length));
    const lines = [`【工作表「${s.name}」：第 ${s.firstRow}–${s.firstRow + s.rows.length - 1} 行，${width} 列】`, ["行", ...Array.from({ length: width }, (_, i) => colName(i))].join("\t")];
    s.rows.forEach((r, i) => {
      if (r.some((c) => c)) lines.push([String(s.firstRow + i), ...Array.from({ length: width }, (_, c) => r[c] ?? "")].join("\t"));
    });
    parts.push(lines.join("\n"));
  }
  if (notes.length) parts.push(`（${notes.join("；")}）`);
  return parts.join("\n\n");
}
