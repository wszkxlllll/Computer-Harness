import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { MAX_WINDOW_PREVIEW_BYTES } from "@computer-harness/protocol";

const MAX_WINDOW_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_WINDOW_PREVIEW_EDGE = 8_192;
const MAX_WINDOW_PREVIEW_PIXELS = 16_777_216;
const MAX_THUMBNAIL_EDGE = 1_600;
const MIN_THUMBNAIL_EDGE = 512;
const MAX_THUMBNAIL_ATTEMPTS = 5;
const THUMBNAIL_SHRINK_FACTOR = 0.8;

interface PngRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

interface PngSyncCodec {
  read(data: Buffer): PngRaster;
  write(image: PngRaster, options?: { readonly deflateLevel?: number }): Buffer;
}

interface PngJsModule {
  readonly PNG: { readonly sync: PngSyncCodec };
}

const pngjs = createRequire(import.meta.url)("pngjs") as PngJsModule;

export type WindowPreviewImageErrorCode = "WINDOW_PREVIEW_CAPTURE_FAILED" | "WINDOW_PREVIEW_IMAGE_TOO_LARGE";

export class WindowPreviewImageError extends Error {
  public constructor(public readonly code: WindowPreviewImageErrorCode, message: string) {
    super(message);
    this.name = "WindowPreviewImageError";
  }
}

export interface NormalizedWindowPreviewImage {
  readonly data: Uint8Array;
  /** Dimensions of the returned preview PNG only; never used as action geometry. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * Keep small candidate previews byte-for-byte. Larger PNGs are decoded only
 * after bounded IHDR validation, then resampled into a preview-only thumbnail.
 * This function never mutates a Run Observation or its original screenshot.
 */
export function normalizeWindowPreviewPng(
  data: Uint8Array,
  viewport: { readonly width: number; readonly height: number },
  signal: AbortSignal,
): NormalizedWindowPreviewImage {
  signal.throwIfAborted();
  if (data.byteLength === 0) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview image is empty.");
  }
  if (data.byteLength > MAX_WINDOW_PREVIEW_SOURCE_BYTES) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_IMAGE_TOO_LARGE", "The preview source exceeds the bounded image-normalization limit.");
  }
  if (data.byteLength <= MAX_WINDOW_PREVIEW_BYTES) {
    return { data, viewport: { ...viewport } };
  }

  const dimensions = readBoundedPngHeader(data, viewport);
  signal.throwIfAborted();
  let decoded: PngRaster;
  try {
    decoded = pngjs.PNG.sync.read(Buffer.from(data));
  } catch {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview source is not a decodable PNG.");
  }
  signal.throwIfAborted();
  if (decoded.width !== dimensions.width || decoded.height !== dimensions.height ||
      decoded.data.byteLength !== dimensions.width * dimensions.height * 4) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The decoded preview dimensions do not match its PNG header.");
  }

  let width = Math.min(dimensions.width, MAX_THUMBNAIL_EDGE);
  let height = Math.max(1, Math.round(dimensions.height * width / dimensions.width));
  if (height > MAX_THUMBNAIL_EDGE) {
    height = MAX_THUMBNAIL_EDGE;
    width = Math.max(1, Math.round(dimensions.width * height / dimensions.height));
  }

  for (let attempt = 0; attempt < MAX_THUMBNAIL_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const raster = resizeRgbaBilinear(decoded, width, height);
    let encoded: Buffer;
    try {
      encoded = pngjs.PNG.sync.write(raster, { deflateLevel: 6 });
    } catch {
      throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview thumbnail could not be encoded.");
    }
    signal.throwIfAborted();
    if (encoded.byteLength <= MAX_WINDOW_PREVIEW_BYTES) {
      return {
        data: new Uint8Array(encoded),
        viewport: { width: raster.width, height: raster.height },
      };
    }

    const nextLongEdge = Math.floor(Math.max(width, height) * THUMBNAIL_SHRINK_FACTOR);
    if (attempt + 1 >= MAX_THUMBNAIL_ATTEMPTS || nextLongEdge < MIN_THUMBNAIL_EDGE) break;
    const scale = THUMBNAIL_SHRINK_FACTOR;
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }

  throw new WindowPreviewImageError(
    "WINDOW_PREVIEW_IMAGE_TOO_LARGE",
    "The preview remains above the safe transfer limit after bounded thumbnail reduction.",
  );
}

/** Full-frame model presentation. No crop, padding, overlays or canonical asset mutation. */
export function resizeModelScreenshotPng(
  bytes: Uint8Array,
  source: { readonly width: number; readonly height: number },
  presented: { readonly width: number; readonly height: number },
  signal: AbortSignal,
): Uint8Array {
  signal.throwIfAborted();
  if (bytes.byteLength > MAX_WINDOW_PREVIEW_SOURCE_BYTES) throw new Error("Model screenshot exceeds bounded decode limit");
  readBoundedPngHeader(bytes, source);
  const { width, height } = presented;
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0)
    || width > source.width || height > source.height
    || Math.abs(width / source.width - height / source.height) > 1 / Math.min(source.width, source.height)) {
    throw new Error("Model screenshot must be an aspect-preserving full-frame reduction");
  }
  const decoded = pngjs.PNG.sync.read(Buffer.from(bytes));
  if (decoded.width !== source.width || decoded.height !== source.height || decoded.data.byteLength !== source.width * source.height * 4) {
    throw new Error("Model screenshot dimensions do not match decoded pixels");
  }
  signal.throwIfAborted();
  if (width === source.width && height === source.height) return bytes;
  const result = pngjs.PNG.sync.write(resizeRgbaBilinear(decoded, width, height), { deflateLevel: 6 });
  signal.throwIfAborted();
  return new Uint8Array(result);
}

function readBoundedPngHeader(
  data: Uint8Array,
  viewport: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.byteLength < 33 || !signature.every((byte, index) => data[index] === byte)) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview source has no valid PNG signature and IHDR.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < data.byteLength) {
    if (data.byteLength - offset < 12) {
      throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG has a truncated chunk header.");
    }
    const chunkLength = view.getUint32(offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > data.byteLength) {
      throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG has a chunk outside its bounded source buffer.");
    }
    const isHeader = isPngChunk(data, offset + 4, "IHDR");
    const isEnd = isPngChunk(data, offset + 4, "IEND");
    if (!sawHeader) {
      if (!isHeader || chunkLength !== 13 || chunkEnd < 33) {
        throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG does not begin with one complete IHDR chunk.");
      }
      sawHeader = true;
      if (data[28] !== 0) {
        throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "Interlaced preview PNGs are not supported by bounded thumbnail decoding.");
      }
    } else if (isHeader) {
      throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG contains more than one IHDR chunk.");
    }
    if (isEnd) {
      if (chunkLength !== 0) {
        throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG has an invalid IEND chunk.");
      }
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG is missing its bounded IHDR or IEND chunk.");
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview PNG has invalid dimensions.");
  }
  if (width > MAX_WINDOW_PREVIEW_EDGE || height > MAX_WINDOW_PREVIEW_EDGE || width * height > MAX_WINDOW_PREVIEW_PIXELS) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_IMAGE_TOO_LARGE", "The preview PNG dimensions exceed the bounded decode limit.");
  }
  if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
      viewport.width !== width || viewport.height !== height) {
    throw new WindowPreviewImageError("WINDOW_PREVIEW_CAPTURE_FAILED", "The preview viewport does not match its PNG dimensions.");
  }
  return { width, height };
}

function isPngChunk(data: Uint8Array, offset: number, expected: string): boolean {
  return data[offset] === expected.charCodeAt(0) && data[offset + 1] === expected.charCodeAt(1) &&
    data[offset + 2] === expected.charCodeAt(2) && data[offset + 3] === expected.charCodeAt(3);
}

function resizeRgbaBilinear(source: PngRaster, width: number, height: number): PngRaster {
  const output = Buffer.allocUnsafe(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const destinationOffset = (y * width + x) * 4;
      const topLeft = (y0 * source.width + x0) * 4;
      const topRight = (y0 * source.width + x1) * 4;
      const bottomLeft = (y1 * source.width + x0) * 4;
      const bottomRight = (y1 * source.width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source.data[topLeft + channel]! * (1 - fx) + source.data[topRight + channel]! * fx;
        const bottom = source.data[bottomLeft + channel]! * (1 - fx) + source.data[bottomRight + channel]! * fx;
        output[destinationOffset + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data: output };
}
