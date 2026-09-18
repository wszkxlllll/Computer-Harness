import stringWidth from "string-width";
import { sanitizeTerminalText } from "./terminal-output.js";

export interface TuiTextPage {
  readonly lines: readonly string[];
  readonly pageIndex: number;
  readonly pageCount: number;
}

const NEWLINE_MARKER = "\uE000";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

export function limitTuiInput(value: string, maxGraphemes: number): { value: string; truncated: boolean } {
  const parts = graphemes(value);
  const limit = Math.max(0, Math.floor(maxGraphemes));
  return { value: parts.slice(0, limit).join(""), truncated: parts.length > limit };
}

export function removeLastTuiGrapheme(value: string): string {
  const parts = graphemes(value);
  return parts.slice(0, -1).join("");
}

/** Wrap sanitized text without splitting a surrogate pair or discarding lines. */
export function wrapTuiText(value: string, width: number): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  // Keep newlines recoverable while sanitizing the complete string, so a
  // control sequence that spans a line boundary cannot leak its tail.
  const sanitized = sanitizeTerminalText(value.replace(/\r\n?/gu, "\n").replace(/\n/gu, NEWLINE_MARKER));
  const rawLines = sanitized.split(NEWLINE_MARKER);
  const wrapped: string[] = [];
  for (const line of rawLines) {
    const clusters = graphemes(line);
    if (clusters.length === 0) {
      wrapped.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const cluster of clusters) {
      const clusterWidth = stringWidth(cluster);
      if (current.length > 0 && currentWidth + clusterWidth > safeWidth) {
        wrapped.push(current);
        current = "";
        currentWidth = 0;
      }
      current += cluster;
      currentWidth += clusterWidth;
    }
    if (current.length > 0) {
      wrapped.push(current);
    }
  }
  return wrapped;
}

export function paginateTuiText(value: string, width: number, pageIndex: number, linesPerPage: number): TuiTextPage {
  const lines = wrapTuiText(value, width);
  const pageSize = Math.max(1, Math.floor(linesPerPage));
  const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
  const boundedPage = Math.min(Math.max(0, Math.floor(pageIndex)), pageCount - 1);
  return {
    lines: lines.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize),
    pageIndex: boundedPage,
    pageCount,
  };
}

/** Keep the newest typed characters visible in a single-line editor. */
export function tailTuiInput(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const sanitized = sanitizeTerminalText(value).replace(/[\r\n]+/gu, " ");
  if (stringWidth(sanitized) <= safeWidth) return sanitized;
  const marker = "…";
  const budget = Math.max(0, safeWidth - stringWidth(marker));
  const selected: string[] = [];
  let used = 0;
  for (const cluster of graphemes(sanitized).reverse()) {
    const clusterWidth = stringWidth(cluster);
    if (used + clusterWidth > budget) break;
    selected.unshift(cluster);
    used += clusterWidth;
  }
  return `${marker}${selected.join("")}`;
}
