import type { NoticeImport } from "@/contracts/inbox";
import { importNotice } from "@/workflows/inbox";
import { linkLegacyCampusTask } from "@/workflows/legacy";
import { getDb } from "@/repositories/db";

export function importCampusNotice(payload: NoticeImport, token: string, evidenceText: string, evidenceOccurredAt: string | null = null, automaticExtraction = true) {
  return getDb().transaction(() => {
    const result = importNotice(payload, token, { automaticExtraction });
    if (!result.ok) return result;
    getDb().prepare("UPDATE inbox_revisions SET extraction_text=?,extraction_occurred_at=? WHERE id=? AND extraction_text IS NULL").run(evidenceText, evidenceOccurredAt, result.revisionId);
    const current = getDb().prepare("SELECT current_revision_id FROM inbox_messages WHERE id=?").get(result.messageId) as { current_revision_id: string };
    const linked = linkLegacyCampusTask(payload.source, payload.externalId, result.messageId, current.current_revision_id);
    return { ...result, linked };
  }).immediate();
}
