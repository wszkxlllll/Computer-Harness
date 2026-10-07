import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MAX_WINDOW_PREVIEW_BYTES } from "@computer-harness/protocol";
import { normalizeWindowPreviewPng, WindowPreviewImageError } from "./window-preview-image.js";

interface FixturePngRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

interface FixturePngModule {
  readonly PNG: {
    readonly sync: {
      read(data: Buffer): FixturePngRaster;
      write(image: FixturePngRaster, options?: { readonly deflateLevel?: number }): Buffer;
    };
  };
}

const pngjs = createRequire(import.meta.url)("pngjs") as FixturePngModule;

describe("window preview PNG normalization", () => {
  it("passes through a small preview without changing its original bytes or viewport", () => {
    const data = Uint8Array.of(1, 2, 3, 4);
    const viewport = { width: 4, height: 2 };
    const normalized = normalizeWindowPreviewPng(data, viewport, new AbortController().signal);

    expect(normalized.data).toBe(data);
    expect(normalized.viewport).toEqual(viewport);
  });

  it("downsamples a valid large PNG under the existing transfer cap and reports the thumbnail dimensions", () => {
    const source = createNoisyPng(2_048, 1_200);
    expect(source.byteLength).toBeGreaterThan(MAX_WINDOW_PREVIEW_BYTES);
    const startedAt = performance.now();
    const normalized = normalizeWindowPreviewPng(
      source,
      { width: 2_048, height: 1_200 },
      new AbortController().signal,
    );
    const elapsedMs = performance.now() - startedAt;
    const decoded = pngjs.PNG.sync.read(Buffer.from(normalized.data));
    expect(normalized.data.byteLength).toBeLessThanOrEqual(MAX_WINDOW_PREVIEW_BYTES);
    expect(normalized.viewport).toEqual({ width: decoded.width, height: decoded.height });
    expect(decoded.width).toBeLessThan(2_048);
    expect(decoded.height).toBeLessThan(1_200);
    expect(elapsedMs).toBeLessThan(8_000);
  });

  it("rejects malformed oversized bytes and oversized IHDR dimensions before PNG decode", () => {
    const malformed = new Uint8Array(MAX_WINDOW_PREVIEW_BYTES + 1);
    expect(() => normalizeWindowPreviewPng(
      malformed,
      { width: 8, height: 8 },
      new AbortController().signal,
    )).toThrow(expect.objectContaining({ code: "WINDOW_PREVIEW_CAPTURE_FAILED" }));

    const oversizedHeader = createNoisyPng(8, 8);
    const data = Buffer.from(oversizedHeader);
    data.writeUInt32BE(8_192, 16);
    data.writeUInt32BE(8_192, 20);
    const aboveTransferCap = Buffer.concat([data, Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES + 1)]);
    try {
      normalizeWindowPreviewPng(aboveTransferCap, { width: 8_192, height: 8_192 }, new AbortController().signal);
      throw new Error("expected a bounded-dimension rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowPreviewImageError);
      expect(error).toMatchObject({ code: "WINDOW_PREVIEW_IMAGE_TOO_LARGE" });
    }
  });

  it("rejects interlaced, duplicate-IHDR, and out-of-bounds chunks before calling pngjs", () => {
    const small = createNoisyPng(8, 8);
    const interlacedHeader = Buffer.from(small);
    interlacedHeader[28] = 1;
    const interlaced = Buffer.concat([interlacedHeader, Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES + 1)]);

    const duplicateHeader = Buffer.from(small.subarray(8, 33));
    duplicateHeader.writeUInt32BE(16, 8);
    const duplicateIhdr = Buffer.concat([
      small.subarray(0, 33),
      duplicateHeader,
      small.subarray(33),
      Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES + 1),
    ]);

    const invalidChunkLength = Buffer.from(small);
    invalidChunkLength.writeUInt32BE(0xffff_ffff, 33);
    const outOfBoundsChunk = Buffer.concat([invalidChunkLength, Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES + 1)]);

    const codec = pngjs.PNG.sync;
    const originalRead = codec.read;
    let decoderCalls = 0;
    codec.read = (data) => {
      decoderCalls += 1;
      return originalRead(data);
    };
    try {
      for (const data of [interlaced, duplicateIhdr, outOfBoundsChunk]) {
        try {
          normalizeWindowPreviewPng(data, { width: 8, height: 8 }, new AbortController().signal);
          throw new Error("expected bounded PNG rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(WindowPreviewImageError);
          expect(error).toMatchObject({ code: "WINDOW_PREVIEW_CAPTURE_FAILED" });
        }
      }
      expect(decoderCalls).toBe(0);
    } finally {
      codec.read = originalRead;
    }
  });

  it("rejects raw source images above the internal cap and respects Abort before decoding", () => {
    const sourceTooLarge = new Uint8Array(16 * 1024 * 1024 + 1);
    expect(() => normalizeWindowPreviewPng(
      sourceTooLarge,
      { width: 1, height: 1 },
      new AbortController().signal,
    )).toThrow(expect.objectContaining({ code: "WINDOW_PREVIEW_IMAGE_TOO_LARGE" }));

    const controller = new AbortController();
    const reason = new Error("preview canceled before normalization");
    controller.abort(reason);
    expect(() => normalizeWindowPreviewPng(
      Uint8Array.of(1),
      { width: 1, height: 1 },
      controller.signal,
    )).toThrow(reason);
  });
});

function createNoisyPng(width: number, height: number): Buffer {
  const data = Buffer.allocUnsafe(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < data.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 0xff;
  }
  return pngjs.PNG.sync.write({ width, height, data }, { deflateLevel: 1 });
}
