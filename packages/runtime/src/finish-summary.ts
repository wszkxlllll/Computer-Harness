/**
 * A finish summary is user-facing content, not merely a control status.
 * Keep this check deliberately narrow: short legitimate answers and useful
 * failure explanations must remain valid; only an exact status label is
 * rejected.
 */
const STATUS_ONLY_LABELS = new Set([
  "ok",
  "okay",
  "done",
  "finished",
  "finish",
  "complete",
  "completed",
  "success",
  "successful",
  "succeeded",
  "failure",
  "failed",
  "fail",
  "taskdone",
  "taskfinished",
  "taskcomplete",
  "taskcompleted",
  "alldone",
  "任务完成",
  "任务已完成",
  "任务成功",
  "已完成",
  "完成",
  "成功",
  "失败",
]);

/**
 * Returns false only for an empty summary or a punctuation/whitespace-free
 * exact status label. It intentionally does not impose a minimum length.
 */
export function isActionableFinishSummary(summary: string): boolean {
  if (typeof summary !== "string") return false;
  const normalized = summary
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return normalized.length > 0 && !STATUS_ONLY_LABELS.has(normalized);
}

export function finishSummaryRejectionReason(summary: string): string | undefined {
  return isActionableFinishSummary(summary)
    ? undefined
    : "finish.summary must contain the user-facing result, not only a completion/failure status label";
}
