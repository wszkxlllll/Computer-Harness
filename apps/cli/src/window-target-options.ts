export interface CuaWindowTargetOption {
  readonly pid: number;
  readonly windowId: number;
}

export function resolveCuaWindowTargetOptions(input: {
  readonly pid?: string | undefined;
  readonly windowId?: string | undefined;
  readonly computer: "cua" | "osworld";
  readonly doctor: boolean;
}): CuaWindowTargetOption | undefined {
  if ((input.pid === undefined) !== (input.windowId === undefined)) {
    throw new Error("--cua-window-pid and --cua-window-id must be provided together");
  }
  if (input.pid === undefined || input.windowId === undefined) return undefined;
  if (input.computer !== "cua") throw new Error("--cua-window-pid/--cua-window-id require --computer cua");
  if (input.doctor) throw new Error("--doctor does not accept a window target");
  return {
    pid: positiveSafeInteger(input.pid, "--cua-window-pid"),
    windowId: positiveSafeInteger(input.windowId, "--cua-window-id"),
  };
}

function positiveSafeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}
