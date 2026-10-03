export type LogDraftDate = {
  occurredOn: string;
  dateMode: "auto" | "manual" | "legacy";
  progress: string;
  blocker: string;
};

/** Only untouched empty defaults roll forward; dated writing and deliberate backdating are preserved. */
export function nextLogDraftDate(draft: LogDraftDate, today: string): string {
  if (!today || draft.dateMode === "manual") return draft.occurredOn;
  if (!draft.occurredOn) return today;
  if (draft.dateMode === "auto" && !draft.progress.trim() && !draft.blocker.trim()) return today;
  return draft.occurredOn;
}
