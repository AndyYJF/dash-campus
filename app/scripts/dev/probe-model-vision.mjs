#!/usr/bin/env node
/**
 * P0：真实探测已配置模型是否支持图片输入（总规划 §3.1）。
 * 发送一次文本基准请求 + 一次带 1x1 PNG 的图片请求，报告二者结果。
 * 不打印 API key；失败信息截断。用法：node scripts/dev/probe-model-vision.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const endpoint = (env.MODEL_ENDPOINT || "").replace(/\/+$/, "");
const url = endpoint.endsWith("/chat/completions") ? endpoint : `${endpoint}/chat/completions`;
const model = env.MODEL_NAME;
if (!env.MODEL_API_KEY || !endpoint || !model) {
  console.log("RESULT: not_configured（缺 MODEL_ENDPOINT/MODEL_NAME/MODEL_API_KEY）");
  process.exit(0);
}

// 1x1 纯红 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function probe(label, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MODEL_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(`${label}: HTTP ${res.status} — ${body.slice(0, 300)}`);
      return false;
    }
    const json = JSON.parse(body);
    const text = json.choices?.[0]?.message?.content ?? "";
    console.log(`${label}: HTTP 200 — 回复: ${String(text).slice(0, 100)}`);
    return true;
  } catch (e) {
    console.log(`${label}: 请求失败 — ${e.name === "AbortError" ? "超时45s" : String(e).slice(0, 200)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const textOk = await probe("文本基准", "只回答两个字：正常");
const visionOk = await probe("图片输入", [
  { type: "text", text: "这张图片是什么颜色？只回答颜色名。" },
  { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
]);

console.log(
  `RESULT: model=${model} endpoint=${new URL(url).host} text=${textOk ? "ok" : "fail"} vision=${visionOk ? "ok" : "fail"}`,
);
