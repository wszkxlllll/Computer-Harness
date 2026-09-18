import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { reduceMemoryMutation, type MemoryMutation, type MemoryState, type RunId } from "@computer-harness/protocol";
import {
  MAX_MEMORY_RUN_ID_LENGTH,
} from "./constants.js";
import {
  cloneMemory,
  emptyMemory,
  normalizeMemoryMutation,
  parseMemoryState,
  validateBoundedString,
  validateMemoryState,
  validateMutationReferences,
} from "./validation.js";

export interface MemoryStore {
  get(runId: RunId): Promise<MemoryState>;
  apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState>;
  rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly states = new Map<RunId, MemoryState>();

  public async get(runId: RunId): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    return cloneMemory(this.states.get(runId) ?? emptyMemory(runId));
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    const current = await this.get(runId);
    const normalized = normalizeMemoryMutation(mutation);
    validateMutationReferences(current, normalized);
    const next = reduceMemoryMutation(current, normalized);
    validateMemoryState(next, runId);
    this.states.set(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    let state = emptyMemory(runId);
    for (const mutation of mutations) {
      const normalized = normalizeMemoryMutation(mutation);
      validateMutationReferences(state, normalized);
      state = reduceMemoryMutation(state, normalized);
    }
    validateMemoryState(state, runId);
    this.states.set(runId, state);
    return cloneMemory(state);
  }
}

export class FileMemoryStore implements MemoryStore {
  public constructor(private readonly rootDir: string) {}

  public async get(runId: RunId): Promise<MemoryState> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(runId), "utf8")) as unknown;
      return cloneMemory(parseMemoryState(value, runId));
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return emptyMemory(runId);
      if (error instanceof Error && error.message.startsWith("memory.json")) throw error;
      throw new Error(`memory.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async apply(runId: RunId, mutation: MemoryMutation): Promise<MemoryState> {
    const current = await this.get(runId);
    const normalized = normalizeMemoryMutation(mutation);
    validateMutationReferences(current, normalized);
    const next = reduceMemoryMutation(current, normalized);
    validateMemoryState(next, runId);
    await this.write(runId, next);
    return cloneMemory(next);
  }

  public async rebuild(runId: RunId, mutations: readonly MemoryMutation[]): Promise<MemoryState> {
    let next = emptyMemory(runId);
    for (const mutation of mutations) {
      const normalized = normalizeMemoryMutation(mutation);
      validateMutationReferences(next, normalized);
      next = reduceMemoryMutation(next, normalized);
    }
    validateMemoryState(next, runId);
    await this.write(runId, next);
    return cloneMemory(next);
  }

  private async write(runId: RunId, state: MemoryState): Promise<void> {
    const path = this.pathFor(runId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private pathFor(runId: RunId): string {
    validateBoundedString(runId, "runId", MAX_MEMORY_RUN_ID_LENGTH);
    if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) throw new Error("invalid run id for MemoryStore");
    return join(this.rootDir, runId, "memory.json");
  }
}
