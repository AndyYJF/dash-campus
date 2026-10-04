import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { listItems } from "@/repositories/intakes";
import { parseCsv, parseXlsx, sheetsToText } from "@/domain/spreadsheet";
import { downscale, encodePng } from "@/domain/png";
import { extractPdf } from "@/workflows/intake-files";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";

/**
 * 附件本地解析（MASTER-PLAN §3.1；E18、A14/A15 的隔离行为）：
 * XLSX/CSV 读出单元格与行列位置，不执行公式/宏；扫描 PDF 的页面图像走图片识别并保留页码。
 * 表格样本由真实的表格库（openpyxl）生成；扫描 PDF 是测试里拼出来的合成文件，不是真实扫描件。
 * 模型是假件：这里只证明“交给模型的是什么”，不证明真实模型能读对。
 */

let sessionToken = "";
let csrfToken = "";
let seq = 0;
let lastContext: { text?: string; images?: string[] } = {};

function fileOf(name: string, type: string, content: string | Uint8Array): File {
  return new File([content as BlobPart], name, { type });
}
async function upload(files: File[], text = ""): Promise<string> {
  const form = new FormData();
  if (text) form.append("text", text);
  for (const f of files) form.append("files", f);
  const res = await createIntakeRoute(
    new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "idempotency-key": `mf-${seq++}` }, body: form }),
  );
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  return intakeId;
}
const docs = (intakeId: string) => getDb().prepare(`SELECT source_kind, locator, content_text FROM extracted_documents WHERE intake_id = ? ORDER BY locator`).all(intakeId) as Array<{ source_kind: string; locator: string | null; content_text: string }>;

/** 合成 PDF：给定每页是“整页图像”（扫描页）还是一行文字 */
function buildPdf(pages: Array<{ scan: { width: number; height: number; rgb: [number, number, number] } } | { text: string }>): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  // 1: catalog, 2: pages, 3: font；之后每页 2–3 个对象
  const kids: number[] = [];
  const pageObjs: Array<() => void> = [];
  let next = 4;
  for (const p of pages) {
    const pageId = next++;
    kids.push(pageId);
    if ("scan" in p) {
      const imgId = next++;
      const contentId = next++;
      const { width, height, rgb } = p.scan;
      const raw = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) raw.set(rgb, i * 3);
      pageObjs.push(() => {
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
        add(stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(raw)));
        add(stream("", Buffer.from("q 595 0 0 842 0 0 cm /Im0 Do Q", "latin1")));
      });
    } else {
      const contentId = next++;
      pageObjs.push(() => {
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
        add(stream("", Buffer.from(`BT /F1 18 Tf 72 720 Td (${p.text}) Tj ET`, "latin1")));
      });
    }
  }
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const f of pageObjs) f();
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let pos = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(obj);
    pos += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

function pngInfo(dataUrl: string): { width: number; height: number; firstPixel: number[] } {
  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG 文件头");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const idatLen = buf.readUInt32BE(33);
  const pixels = zlib.inflateSync(buf.subarray(41, 41 + idatLen));
  return { width, height, firstPixel: [...pixels.subarray(1, 4)] };
}

before(() => {
  migrateAll();
  createOwner(hashPassword("mf-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        lastContext = req.context as { text?: string; images?: string[] };
        const text = (lastContext.text ?? "").trim();
        return { ok: true, validatedResult: { items: [{ itemKey: "m-1", kind: "note", summary: text.slice(0, 30) || "图片内容", excerpt: text.slice(0, 80) || "图片" }] } };
      }),
    },
  });
});

test("XLSX（真实表格库生成）：读出各工作表的单元格与行列位置；合并单元格、日期、隐藏表、公式都按规格处理", () => {
  const r = parseXlsx(new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/timetable-sample.xlsx"))));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.sheets.map((s) => s.name), ["课表", "作业"], "隐藏的工作表不读");
  const [tt, hw] = r.sheets;
  assert.deepEqual(tt!.rows[0], ["节次", "时间", "周一", "周二", "周三"]);
  assert.equal(tt!.rows[1]![2], "高等数学 / 张老师 A101 / 1-18周", "单元格里的换行保留为分隔");
  assert.equal(tt!.rows[2]![4], tt!.rows[1]![4], "合并单元格 E2:E3：两行都能看到这门课");
  assert.equal(tt!.rows[2]![3] ?? "", "", "真正空的格子还是空");
  assert.deepEqual(tt!.rows[3], [], "中间的空行占位，行号才对得上");
  assert.equal(tt!.rows[4]![1], "第6、10周周一 3-4 节形势与政策");
  assert.equal(hw!.rows[1]![1], "2026-10-12 23:00", "日期时间按格式换算，不是一串序列号");
  assert.equal(hw!.rows[2]![1], "2026-10-15");
  assert.equal(hw!.rows[2]![0], "离散数学作业 & <第3章>", "XML 转义还原");
  assert.equal(hw!.rows[2]![2], "45.5");
  assert.equal(hw!.rows[1]![3], "（公式，文件里没有计算结果）", "公式没有缓存值：标未知，不替主人计算");
  assert.ok(r.notes.some((n) => /1 个单元格是公式且文件里没有保存计算结果/.test(n)));

  const text = sheetsToText(r.sheets, r.notes);
  assert.match(text, /【工作表「课表」：第 1–5 行，5 列】\n行\tA\tB\tC\tD\tE\n1\t节次\t时间\t周一\t周二\t周三/);
  assert.match(text, /\n5\t备注\t第6、10周周一 3-4 节形势与政策/, "行号是文件里的实际行号");
});

test("XLSX 限额与异常：不是表格、旧版 .xls、压缩炸弹、超过 5 个工作表都如实说明", () => {
  const bad = parseXlsx(new TextEncoder().encode("这不是表格"));
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /不是有效的 \.xlsx/);

  // 手工拼一个 zip：7 个工作表 + 一个宏部件
  const files: Array<[string, string]> = [
    ["xl/workbook.xml", `<workbook><sheets>${Array.from({ length: 7 }, (_, i) => `<sheet name="表${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships>${Array.from({ length: 7 }, (_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`],
    ...Array.from({ length: 7 }, (_, i) => [`xl/worksheets/sheet${i + 1}.xml`, `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>内容${i + 1}</t></is></c><c r="B1"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>`] as [string, string]),
    ["xl/vbaProject.bin", "MACRO"],
  ];
  const many = parseXlsx(zip(files));
  assert.ok(many.ok, many.ok ? "" : many.error);
  assert.equal(many.sheets.length, 5);
  assert.equal(many.sheets[0]!.rows[0]![1], "3", "公式取文件里缓存的结果");
  assert.ok(many.notes.some((n) => /共 7 个工作表，只读了前 5 个（「表6」、「表7」 没读）/.test(n)), many.notes.join("|"));
  assert.ok(many.notes.some((n) => /宏没有被读取或执行/.test(n)));

  // 压缩炸弹：一个工作表解压后超过 64MiB
  const bomb = parseXlsx(zip([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="大" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", " ".repeat(65 * 1024 * 1024)],
  ]));
  assert.equal(bomb.ok, false);
  assert.match(bomb.ok ? "" : bomb.error, /超过 64MiB/);
});

/** 最小 zip 写入器（deflate），只给测试拼 xlsx 用 */
function zip(files: Array<[string, string]>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = zlib.deflateRawSync(Buffer.from(content, "utf8"));
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(Buffer.byteLength(content), 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, end]));
}

test("CSV：引号/换行/分隔符按规范拆；GBK 文件检测后标记编码；没闭合的引号准确失败", () => {
  const utf8 = parseCsv(new TextEncoder().encode('﻿任务,截止,备注\n"实验报告, 第二版",2026-10-12,"两行\n备注"\n\n"带""引号""的",,\n'));
  assert.ok(utf8.ok);
  assert.deepEqual(utf8.ok ? utf8.sheets[0]!.rows : [], [["任务", "截止", "备注"], ["实验报告, 第二版", "2026-10-12", "两行\n备注"], ['带"引号"的', "", ""]]);
  assert.deepEqual(utf8.ok ? utf8.notes : ["x"], []);

  // “课程;教师\r\n高等数学;张老师” 的 GBK 字节
  const gbk = Uint8Array.from([0xbf, 0xce, 0xb3, 0xcc, 0x3b, 0xbd, 0xcc, 0xca, 0xa6, 0x0d, 0x0a, 0xb8, 0xdf, 0xb5, 0xc8, 0xca, 0xfd, 0xd1, 0xa7, 0x3b, 0xd5, 0xc5, 0xc0, 0xcf, 0xca, 0xa6]);
  const g = parseCsv(gbk);
  assert.ok(g.ok);
  assert.deepEqual(g.ok ? g.sheets[0]!.rows : [], [["课程", "教师"], ["高等数学", "张老师"]]);
  assert.match(g.ok ? g.notes.join("") : "", /不是 UTF-8，已按 GBK\/GB18030 读取/);

  const broken = parseCsv(new TextEncoder().encode('a,b\n"没闭合,c\n'));
  assert.equal(broken.ok, false);
});

test("PNG 编码：像素原样可还原；过大的页面按整数倍缩小", () => {
  const img = { data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]), width: 2, height: 2, channels: 3 as const };
  const info = pngInfo(`data:image/png;base64,${encodePng(img).toString("base64")}`);
  assert.deepEqual([info.width, info.height, info.firstPixel], [2, 2, [255, 0, 0]]);
  const big = { data: new Uint8Array(4000 * 10 * 1).fill(200), width: 4000, height: 10, channels: 1 as const };
  const small = downscale(big, 1800);
  assert.deepEqual([small.width, small.height, small.data[0]], [1333, 3, 200]);
});

test("扫描 PDF：有文字的页本地取文字并保留页码；没有文字层的页取出页面图像；什么都取不出的页单独列出", async () => {
  const pdf = buildPdf([{ scan: { width: 300, height: 400, rgb: [12, 120, 200] } }, { text: "Lab report due 2026-10-20 23:00" }, { scan: { width: 40, height: 40, rgb: [0, 0, 0] } }]);
  const r = await extractPdf(pdf);
  assert.ok(r, "合成 PDF 能被真实的 PDF 解析器打开");
  assert.equal(r.pages, 3);
  assert.deepEqual(r.textPages.map((p) => [p.page, p.text]), [[2, "Lab report due 2026-10-20 23:00"]]);
  assert.deepEqual(r.scannedPages.map((p) => p.page), [1]);
  const info = pngInfo(r.scannedPages[0]!.dataUrl);
  assert.deepEqual([info.width, info.height, info.firstPixel], [300, 400, [12, 120, 200]], "页面图像原样转成 PNG");
  assert.deepEqual(r.unreadablePages, [3], "只有一枚小图的页不当成扫描页");
  assert.equal(await extractPdf(new TextEncoder().encode("not a pdf")), null);
});

test("投递扫描 PDF：页面图像作为图片交给识别，文字里带页码；超出一次 5 张的页如实列为未处理", async () => {
  const pages = [{ text: "Syllabus page" }, ...Array.from({ length: 6 }, (_, i) => ({ scan: { width: 240, height: 320, rgb: [i * 30, 100, 100] as [number, number, number] } }))];
  const intakeId = await upload([fileOf("校历扫描.pdf", "application/pdf", buildPdf(pages))]);
  assert.equal(lastContext.images?.length, 5, "一次最多 5 张图");
  assert.match(lastContext.text ?? "", /【校历扫描\.pdf 第 1 页】\nSyllabus page/);
  assert.match(lastContext.text ?? "", /【校历扫描\.pdf 第 2、3、4、5、6 页是扫描页：内容见随附图片（按页码顺序）】/);
  const d = docs(intakeId);
  assert.deepEqual(d.filter((x) => x.source_kind === "pdf-scan").map((x) => x.locator), [2, 3, 4, 5, 6].map((p) => `校历扫描.pdf#page=${p}`), "每张图对应哪一页留有证据");
  assert.deepEqual(d.filter((x) => x.source_kind === "pdf").map((x) => x.locator), ["校历扫描.pdf#page=1"]);
  const failed = listItems(intakeId).find((i) => i.state === "failed");
  assert.match(String(failed?.evidence?.error ?? ""), /第 7 页是扫描页，这次没有处理（一次最多看 5 张图）.*请把这些页单独再发一次/);
});

test("投递 XLSX 与 GBK CSV：交给理解的是带行列位置的表格文字，证据记下工作表与行范围；旧版 .xls 准确失败并保留原件", async () => {
  const xlsx = fs.readFileSync(path.join(__dirname, "fixtures/timetable-sample.xlsx"));
  const intakeId = await upload([fileOf("我的课表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Uint8Array(xlsx))]);
  assert.match(lastContext.text ?? "", /附件「我的课表\.xlsx」的表格内容（带行号和列字母）/);
  assert.match(lastContext.text ?? "", /2\t1-2\t08:15-09:55\t高等数学 \/ 张老师 A101 \/ 1-18周/);
  assert.deepEqual(docs(intakeId).filter((x) => x.source_kind === "xlsx").map((x) => x.locator), ["我的课表.xlsx#课表!A1:5; 作业!A1:3"]);

  const gbk = Uint8Array.from([0xbf, 0xce, 0xb3, 0xcc, 0x2c, 0xbd, 0xcc, 0xca, 0xa6, 0x0a, 0xb8, 0xdf, 0xb5, 0xc8, 0xca, 0xfd, 0xd1, 0xa7, 0x2c, 0xd5, 0xc5, 0xc0, 0xcf, 0xca, 0xa6, 0x0a]);
  await upload([fileOf("courses.csv", "text/csv", gbk)]);
  assert.match(lastContext.text ?? "", /1\t课程\t教师\n2\t高等数学\t张老师/);
  assert.match(lastContext.text ?? "", /已按 GBK\/GB18030 读取/);

  const old = await upload([fileOf("old.xls", "application/vnd.ms-excel", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))]);
  const item = listItems(old).find((i) => i.state === "failed");
  assert.match(String(item?.evidence?.error ?? ""), /旧版 \.xls 表格读不了：请在表格软件里另存为 \.xlsx 或 \.csv 再发。原件已保留/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM intake_attachments WHERE intake_id = ?`).get(old) as { n: number }).n, 1, "原件还在");
});
