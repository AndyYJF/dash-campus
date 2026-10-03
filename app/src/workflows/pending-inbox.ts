import { getDecisionByRevision, getRevision, listMessages } from "@/repositories/inbox";

/** Current actionable notices only; upstream history stays in the inbox, without changing owner tasks. */
export function listPendingInboxDecisions() {
  return listMessages({ status: "active" }).flatMap((message) => {
    if (!message.currentRevisionId) return [];
    const revision = getRevision(message.currentRevisionId);
    const decision = getDecisionByRevision(message.currentRevisionId);
    if (!revision || !decision || !["action", "review"].includes(decision.partition)) return [];
    if (revision.legacyStatus === "completed" || revision.legacyStatus === "cancelled") return [];
    return [{
      kind: "inbox" as const,
      id: message.id,
      title: revision.structured?.action?.title ?? revision.legacyTitle ?? revision.text.slice(0, 60),
      version: decision.version,
      href: `/inbox/${message.id}`,
    }];
  });
}
