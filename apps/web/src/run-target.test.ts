import { describe, expect, it } from "vitest";
import { isValidBrowserUrl } from "./run-target";

describe("browser run target validation", () => {
  it("accepts explicit HTTP and HTTPS URLs", () => {
    expect(isValidBrowserUrl("https://example.com/path?q=1")).toBe(true);
    expect(isValidBrowserUrl(" http://localhost:8080 ")).toBe(true);
  });

  it("rejects missing hosts, other protocols, credentials, and oversized URLs", () => {
    expect(isValidBrowserUrl("https:example.com")).toBe(false);
    expect(isValidBrowserUrl("file:///C:/report.html")).toBe(false);
    expect(isValidBrowserUrl("https://user:pass@example.com")).toBe(false);
    expect(isValidBrowserUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  });
});
