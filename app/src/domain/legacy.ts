import crypto from "node:crypto";
import type { LegacyTask } from "@/contracts/legacy";
import { resolveWallTime } from "@/domain/time";

export function legacyHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 旧校园 note 含图片访问 token。进入预览、来源记录或日志前先脱敏。 */
export function redactLegacyText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      let changed = false;
      if (url.username || url.password) { url.username = ""; url.password = ""; changed = true; }
      for (const key of [...url.searchParams.keys()]) {
        if (/token|key|secret|password|signature|credential|authorization|auth|sig/i.test(key)) {
          url.searchParams.delete(key); changed = true;
        }
      }
      // Fragment 可能是凭证，凭证 URL 不保留片段。
      if (changed) { url.hash = ""; return url.toString(); }
      return raw;
    } catch { return "[无效链接已移除]"; }
  }).replace(/(authorization\s*[=:]\s*)(?:Bearer|Basic)\s+[^\s&"'<>]+/gi, "$1[已移除]")
    .replace(/((?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&"'<>]+)/gi, "$1[已移除]");
}

export function sanitizeLegacyTask(task: LegacyTask): LegacyTask {
  return { ...task, title: redactLegacyText(task.title), note: redactLegacyText(task.note), project: redactLegacyText(task.project),
    start_at: task.start_at ? redactLegacyText(task.start_at) : null, due_at: task.due_at ? redactLegacyText(task.due_at) : null,
    done_at: task.done_at ? redactLegacyText(task.done_at) : null,
    created_at: redactLegacyText(task.created_at), updated_at: redactLegacyText(task.updated_at) };
}

/** 返回 null 并提示保留原始值；绝不把无效/模糊 DST 时刻自动纠正成截止。 */
export function legacyInstant(value: string | null, timezone: string, label: string, warnings: string[]): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(value);
  if (!match || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    warnings.push(`${label}格式不支持，原值留在来源记录`); return null;
  }
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) {
    warnings.push(`${label}日期无效，原值留在来源记录`); return null;
  }
  const result = resolveWallTime(match[1], match[2], timezone);
  if (result.adjustment !== "none") {
    warnings.push(`${label}处于夏令时跳跃或重复区间，需手工确认，原值留在来源记录`); return null;
  }
  return result.instant.toISOString();
}

export function legacyProjectKey(name: string): string { return legacyHash(name); }
