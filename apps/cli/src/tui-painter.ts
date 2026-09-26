/** Paint only changed terminal rows after the first frame. */
export function createTuiPainter(write: (text: string) => void): {
  paint(frame: string): void;
  invalidate(): void;
} {
  let previous: string[] | undefined;
  return {
    paint(frame) {
      const lines = frame.replace(/\n$/u, "").split("\n");
      if (previous === undefined) {
        write(`\u001b[H\u001b[2J${frame}`);
      } else {
        let update = "";
        for (let row = 0; row < Math.max(previous.length, lines.length); row += 1) {
          if (previous[row] === lines[row]) continue;
          update += `\u001b[${row + 1};1H\u001b[2K${lines[row] ?? ""}`;
        }
        if (update.length > 0) write(update);
      }
      previous = lines;
    },
    invalidate() { previous = undefined; },
  };
}
