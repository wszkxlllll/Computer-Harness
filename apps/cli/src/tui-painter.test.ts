import { describe, expect, it } from "vitest";
import { createTuiPainter } from "./tui-painter.js";

describe("TUI painter", () => {
  it("updates changed rows without clearing the whole terminal on every keystroke", () => {
    const writes: string[] = [];
    const painter = createTuiPainter((text) => writes.push(text));
    painter.paint("Header\nGoal: a\nFooter\n");
    expect(writes).toEqual(["\u001b[H\u001b[2JHeader\nGoal: a\nFooter\n"]);

    painter.paint("Header\nGoal: ab\nFooter\n");
    expect(writes[1]).toBe("\u001b[2;1H\u001b[2KGoal: ab");
    painter.paint("Header\nGoal: ab\nFooter\n");
    expect(writes).toHaveLength(2);

    painter.paint("Header\nFooter\n");
    expect(writes[2]).toContain("\u001b[3;1H\u001b[2K");
    painter.invalidate();
    painter.paint("Header\nFooter\n");
    expect(writes[3]).toBe("\u001b[H\u001b[2JHeader\nFooter\n");
  });
});
