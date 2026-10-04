import { z } from "zod";

/**
 * 把工作流的 Zod 输出 schema 转成 OpenAI 兼容 `response_format: json_schema` 的载荷。
 * strict 模式只接受子集（每个对象 additionalProperties=false、全部属性 required、节点都有类型）；
 * 不满足时仍发送 schema 作引导但 strict=false。服务端 Zod 校验始终是最终裁决。
 */

export type ProviderJsonSchema = { name: string; strict: boolean; schema: Record<string, unknown> };

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 返回该节点及子节点是否满足 strict 子集；同时就地补 additionalProperties=false */
function adapt(node: Node): boolean {
  let strictOk = true;
  delete node.$schema;
  const hasType = "type" in node || "enum" in node || "const" in node || "anyOf" in node || "oneOf" in node || "allOf" in node || "$ref" in node;
  if (!hasType) strictOk = false;
  if (node.type === "object" || isNode(node.properties)) {
    const props = isNode(node.properties) ? node.properties : {};
    if (node.additionalProperties === undefined) node.additionalProperties = false;
    else if (node.additionalProperties !== false) strictOk = false;
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    if (Object.keys(props).some((k) => !required.has(k))) strictOk = false;
    for (const v of Object.values(props)) if (isNode(v) && !adapt(v)) strictOk = false;
  }
  if (isNode(node.items) && !adapt(node.items)) strictOk = false;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const v of list) if (isNode(v) && !adapt(v)) strictOk = false;
  }
  for (const key of ["$defs", "definitions"]) {
    const defs = node[key];
    if (isNode(defs)) for (const v of Object.values(defs)) if (isNode(v) && !adapt(v)) strictOk = false;
  }
  if ("default" in node) strictOk = false;
  return strictOk;
}

/** 转换失败（不可表示的类型等）返回 null，调用方退回 json_object */
export function toProviderJsonSchema(workflow: string, schema: z.ZodType): ProviderJsonSchema | null {
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
  if (!isNode(json) || json.type !== "object") return null;
  const strict = adapt(json);
  const name = workflow.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "output";
  return { name, strict, schema: json };
}
