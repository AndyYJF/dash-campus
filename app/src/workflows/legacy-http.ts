import { LEGACY_MAX_BYTES } from "@/contracts/legacy";
import { HttpError } from "@/workflows/http";

export async function readLegacyBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LEGACY_MAX_BYTES) { await reader.cancel(); throw new HttpError(413, "TOO_LARGE", "迁移文件超过 10 MiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
