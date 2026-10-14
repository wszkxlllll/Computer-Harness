import { describe, expect, it } from "vitest";
import { resolveHostSourceLinkedFinishContract } from "./source-linked-finish-config.js";

describe("Host source-linked finish opt-in", () => {
  it("keeps ordinary Host sessions unchanged when the explicit contract is absent", () => {
    expect(resolveHostSourceLinkedFinishContract({})).toBeUndefined();
  });

  it("accepts only the bounded JSON contract without answer values", () => {
    const contract = { version: "source-linked-finish-v1", fields: [{ fieldId: "cpu", label: "CPU model", required: true }] };
    expect(resolveHostSourceLinkedFinishContract({ HARNESS_SOURCE_LINKED_FINISH_CONTRACT: JSON.stringify(contract) })).toEqual(contract);
    expect(() => resolveHostSourceLinkedFinishContract({ HARNESS_SOURCE_LINKED_FINISH_CONTRACT: "{" })).toThrow(/valid JSON/u);
    expect(() => resolveHostSourceLinkedFinishContract({
      HARNESS_SOURCE_LINKED_FINISH_CONTRACT: JSON.stringify({ ...contract, fields: [{ ...contract.fields[0], answer: "M6" }] }),
    })).toThrow(/invalid or duplicate field/u);
  });
});
