import { describe, expect, it } from "vitest";
import type { EventId, MemoryFact, MemoryState, RunId } from "@computer-harness/protocol";
import { formatMemory } from "./projections.js";

const runId = "memory-projection" as RunId;

function fact(id: string, value: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    subject: { type: "run" },
    key: id,
    value,
    sourceEventId: `${id}-source` as EventId,
    status: "active",
    updatedSequence: Number(id.replace("fact-", "")) || 1,
    ...overrides,
  };
}

function crowdedMemory(): MemoryState {
  return {
    runId,
    facts: [
      ...Array.from({ length: 20 }, (_, index) => fact(`fact-${index}`, `value-${index}`)),
      fact("needs", "needs-old", { status: "needs_check", statusReason: "manual_review", updatedSequence: 30 }),
      fact("short", "short-last-known", { retentionClass: "short_lived", updatedSequence: 31 }),
    ],
    entities: [],
  };
}

describe("memory projection packets", () => {
  it("gives hot and revalidation packets an opportunity before remaining index records", () => {
    const projection = formatMemory(crowdedMemory(), undefined, 256);
    expect(projection).toBeDefined();
    expect(projection?.text).toContain("Revalidation candidates");
    expect(projection?.text).toContain("needs-old");
    expect(projection?.text).toContain("short-last-known");
    expect(projection?.text).toContain("Current run memory index");
    expect((projection?.text.split("\n").filter((line) => line.includes("fact-19")).length ?? 0)).toBe(1);
  });

  it("does not partially expose an oversized candidate value", () => {
    const memory = crowdedMemory();
    memory.facts = [fact("long", "secret-prefix-" + "x".repeat(500), { retentionClass: "short_lived" })];
    const projection = formatMemory(memory, undefined, 256);
    expect(projection?.text).toContain("value omitted; query by id");
    expect(projection?.text).not.toContain("secret-prefix-");
  });

  it("reports omission honestly when the packet budget cannot fit a complete group", () => {
    const projection = formatMemory(crowdedMemory(), undefined, 4);
    expect(projection?.truncated).toBe(true);
    expect(projection?.text).toBe("");
  });
});
