import { describe, expect, it } from "vitest";
import { finishSummaryRejectionReason, isActionableFinishSummary } from "./finish-summary.js";

describe("finish summary contract", () => {
  it("rejects exact completion/status labels after punctuation normalization", () => {
    for (const value of ["done", "Done.", "finished!", "任务完成", "任务完成。", "成功"]) {
      expect(isActionableFinishSummary(value), value).toBe(false);
      expect(finishSummaryRejectionReason(value), value).toMatch(/status label/iu);
    }
  });

  it("keeps short answers and useful failure explanations valid", () => {
    for (const value of ["3", "已改签至G245。", "无法完成：需要登录", "No matching train was observed."]) {
      expect(isActionableFinishSummary(value), value).toBe(true);
      expect(finishSummaryRejectionReason(value), value).toBeUndefined();
    }
  });
});
