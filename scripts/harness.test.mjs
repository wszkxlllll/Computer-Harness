import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atLeast, defaultSocket, versionFrom } from "./harness.mjs";

describe("cross-platform local harness launcher", () => {
  it("parses semantic versions from tool output", () => {
    assert.equal(versionFrom("cua-driver 0.22.2"), "0.22.2");
    assert.equal(versionFrom("missing"), undefined);
  });

  it("enforces the supported Node floor", () => {
    assert.equal(atLeast("22.13.0", [22, 13, 0]), true);
    assert.equal(atLeast("22.17.0", [22, 13, 0]), true);
    assert.equal(atLeast("23.0.0", [22, 13, 0]), true);
    assert.equal(atLeast("22.12.9", [22, 13, 0]), false);
    assert.equal(atLeast("21.99.0", [22, 13, 0]), false);
  });

  it("uses an OS-appropriate private endpoint", () => {
    assert.match(defaultSocket(), process.platform === "win32" ? /^\\\\\.\\pipe\\/u : /\.sock$/u);
  });
});
