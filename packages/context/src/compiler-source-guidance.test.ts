import { describe, expect, it } from "vitest";
import type { RunId } from "@computer-harness/protocol";
import { createDefaultToolRegistry } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "./compiler.js";

describe("stable source and progress guidance", () => {
  it("keeps concise source and progress-language guidance in the cacheable system prefix", async () => {
    const compiler = new DefaultContextCompiler(createDefaultToolRegistry(), {
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
    });
    const compile = (runId: string, monitorText: string) => compiler.compile({
      runId: runId as RunId,
      goal: runId.endsWith("-zh") ? "请查阅来源并报告有证据支持的结论。" : `Review source ${runId} and report supported findings.`,
      recentEvents: [],
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: { text: monitorText, fingerprint: `fingerprint-${runId}` },
    }, new AbortController().signal);

    const first = await compile("source-guidance-run-a", "Inspect the newest image before acting.");
    const second = await compile("source-guidance-run-zh", "Earlier report is unverified; check current state.");

    expect(first.system).toContain("When a claim depends on source scope, preserve the relevant applicability limits");
    expect(first.system).toContain("Not found in inspected material is unknown for that scope, not absent everywhere.");
    expect(first.system).toContain("Separate directly observed facts from inference and uncertainty");
    expect(first.system).not.toContain("state which source, date/version, application, and channel");
    expect(first.system).toContain("For user-facing progress.summary notices, follow an explicit user language preference");
    expect(first.system).toContain("otherwise use the language of the user's Goal");
    expect(first.system).toContain("Do not switch to English just because tools, source pages, or interface text are in English");
    expect(first.system).toContain("does not require every response to use one language");
    expect(first.system).toBe(second.system);
    expect(first.contextBudget?.trace?.stablePrefixHash).toBe(second.contextBudget?.trace?.stablePrefixHash);
    expect(first.system).not.toContain("Low-confidence Monitor note");
    expect(JSON.stringify(first.messages)).toContain("Low-confidence Monitor note");
  });
});
