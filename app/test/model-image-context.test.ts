import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildMessages } from "@/integrations/model-json";

test("视觉输入：图片只发送一次；文字保留用户上下文和图片数量，不包含 Base64", () => {
  const images = ["data:image/png;base64,YWJj", "data:image/png;base64,ZGVm"];
  const messages = buildMessages({ workflow: "calendar_extract", instructions: "读取校历", context: { text: "本科校历", images, referenceDate: "2026-10-04" }, outputSchemaVersion: 1, timeoutMs: 45000, schema: z.object({}) });
  const content = messages[1]!.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 3);
  assert.equal(content[0]!.type, "text");
  if (content[0]!.type !== "text") throw new Error("missing text context");
  const context = JSON.parse(content[0]!.text).context;
  assert.equal(context.text, "本科校历");
  assert.equal(context.referenceDate, "2026-10-04");
  assert.equal(context.imageCount, 2);
  assert.ok(!content[0]!.text.includes("base64"));
  assert.deepEqual(content.slice(1), images.map(url => ({ type: "image_url", image_url: { url } })));
});
