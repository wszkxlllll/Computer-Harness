import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssetId } from "@computer-harness/protocol";
import { FileAssetStore } from "./index.js";

describe("FileAssetStore AssetReader", () => {
  it("reads only the exact published asset and honors cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "computer-harness-assets-"));
    try {
      const store = new FileAssetStore(directory);
      const ref = await store.put({ assetId: "asset-reader" as AssetId, relativePath: "screenshots/one.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) });
      await expect(store.read(ref, new AbortController().signal)).resolves.toEqual(new Uint8Array([1, 2, 3]));
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled"));
      await expect(store.read(ref, cancelled.signal)).rejects.toThrow("cancelled");
      await expect(store.read({ ...ref, byteLength: 4 }, new AbortController().signal)).rejects.toThrow(/byte length mismatch/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
