import { describe, expect, it } from "vitest";
import { shouldEstablishSession } from "./pairing-state";

describe("pairing confirmation", () => {
  it("creates the phone session only after local approval", () => {
    expect(shouldEstablishSession("pending_local_confirmation")).toBe(false);
    expect(shouldEstablishSession("rejected")).toBe(false);
    expect(shouldEstablishSession("expired")).toBe(false);
    expect(shouldEstablishSession("approved")).toBe(true);
  });
});
