/**
 * Remove terminal control sequences from untrusted text before it is joined
 * with the TUI frame or written to a terminal.  The renderer owns its small
 * set of cursor/clear-screen controls; model, error, path, and user text do
 * not get to emit controls of their own.
 */
export function sanitizeTerminalText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = skipCsi(value, index + 2);
      } else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipStringControl(value, index + 2);
      } else {
        // A two-byte ESC sequence (including an incomplete one) is discarded.
        index += 1;
      }
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipStringControl(value, index + 1);
      continue;
    }
    if (isTerminalControl(code) || isBidiControl(code)) {
      result += " ";
      continue;
    }
    result += value[index];
  }
  return result;
}

function skipCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length - 1;
}

function skipStringControl(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07) return index;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 1;
    if (code >= 0x80 && code <= 0x9f) return index;
  }
  return value.length - 1;
}

function isTerminalControl(code: number): boolean {
  return (code >= 0 && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function isBidiControl(code: number): boolean {
  return code === 0x061c || code === 0x2028 || code === 0x2029 ||
    (code >= 0x200b && code <= 0x200c) || (code >= 0x200e && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}
