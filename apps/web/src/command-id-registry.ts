import { ApiError } from "./types";

export class CommandIdRegistry {
  private readonly ids = new Map<string, string>();

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  forAction(actionKey: string): string {
    const existing = this.ids.get(actionKey);
    if (existing) return existing;
    const created = this.createId();
    this.ids.set(actionKey, created);
    return created;
  }

  complete(actionKey: string): void {
    this.ids.delete(actionKey);
  }
}

export function shouldClearAfterFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}
