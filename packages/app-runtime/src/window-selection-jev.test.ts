import { describe, expect, it, vi } from "vitest";
import { createJevWindowSelector } from "./window-selection-jev.js";

function matchedResponse(): Response {
  return {
    ok: true,
    async json() {
      return {
        model: "jev-1.13.0",
        answers: { target: { type: "choice", choice: "w1", confidence: 0.9, probabilities: { w1: 0.9, none: 0.1 } } },
      };
    },
  } as Response;
}

describe("Jev initial window selection instructions", () => {
  it("asks for a safe first-phase starting window rather than a complete-task title match", async () => {
    const candidates = [{ pid: 1, windowId: 11, appName: "Editor", title: "Untitled" }];
    const fetcher = vi.fn(async () => matchedResponse()) as unknown as typeof fetch;
    const selector = createJevWindowSelector("test-key", fetcher);

    await expect(selector.select(
      "Create a new budget report and then send it",
      candidates,
      new AbortController().signal,
      "initial",
    )).resolves.toEqual({ kind: "matched", target: candidates[0] });

    const call = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      questions: { target: { instructions: string; criteria: Record<string, string> } };
    };
    const { instructions, criteria } = body.questions.target;
    expect(instructions).toContain("begin the task's first phase");
    expect(instructions).toContain("do not require a future output filename or title to already exist");
    expect(instructions).toContain("switch applications later");
    expect(instructions).not.toContain("more than one application is required");
    expect(criteria.none).toContain("safe starting window for the first phase");
    expect(criteria.none).toContain("cannot be identified unambiguously");
    expect(instructions).not.toMatch(/Notepad|WPS/i);
  });
});
