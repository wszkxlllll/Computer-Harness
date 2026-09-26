import type { MemoryMutation, MemoryState, PlanState, RunId, RuntimeEvent } from "@computer-harness/protocol";
import type { MemoryRecallService, NonComputerToolDefinition } from "@computer-harness/runtime";
import { cloneMemory } from "./validation.js";
import type { HybridMemoryRecallService } from "./retrieval/hybrid-recall.js";
import { createMemoryTools, type MemoryToolMode } from "./tools.js";
import type { MemoryStore } from "./store.js";

/** One Run's coordinated Memory behavior. restoreFromEvents is an explicit
 * offline recovery API; app-runtime does not invoke it to resume a Run. */
export interface MemoryRunModule {
  readonly runId: RunId;
  readonly tools: readonly NonComputerToolDefinition[];
  readonly recall?: MemoryRecallService;
  apply(mutation: MemoryMutation): Promise<MemoryState>;
  /** Explicit offline recovery from committed Events; not used to resume a live Run. */
  restoreFromEvents(events: readonly RuntimeEvent[]): Promise<MemoryState>;
  projectContext(memory: MemoryState, plan: PlanState | undefined): MemoryState | Promise<MemoryState>;
  /** Release module-owned resources when the app-runtime Run closes. */
  close?(): Promise<void>;
}

export interface MemoryRunModuleOptions {
  readonly mode: MemoryToolMode;
  readonly retrieval?: HybridMemoryRecallService;
  readonly recall?: MemoryRecallService;
  readonly tools?: readonly NonComputerToolDefinition[];
  readonly projectContext?: (memory: MemoryState, plan: PlanState | undefined) => MemoryState | Promise<MemoryState>;
  readonly close?: () => Promise<void>;
}

/** Return Memory mutations in committed Event order for one Run. */
export function memoryMutationsFromEvents(events: readonly RuntimeEvent[], runId: RunId): MemoryMutation[] {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "memory.updated" }> => event.runId === runId && event.type === "memory.updated")
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => event.mutation);
}

/** Assemble a Run-scoped Memory module around one store and its retrieval services. */
export function createMemoryRunModule(
  runId: RunId,
  store: MemoryStore,
  options: MemoryRunModuleOptions,
): MemoryRunModule {
  const tools = options.tools ?? createMemoryTools(store, options.mode, {
    ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
    afterMemoryCommit: false,
  });
  if (tools.some((tool) => tool.category !== "side")) {
    throw new Error("MemoryRunModule tools must use the side category");
  }
  if (tools.some((tool) => tool.memoryMutationFromResult !== undefined && tool.afterMemoryCommit !== undefined)) {
    throw new Error("MemoryRunModule mutation tools must leave afterMemoryCommit to app-runtime");
  }
  const materialize = async (mutation: MemoryMutation): Promise<MemoryState> => {
    const next = await store.apply(runId, mutation);
    options.retrieval?.syncState(next);
    return next;
  };
  return {
    runId,
    tools: tools.map((tool) => ({
      ...tool,
      async execute(args, context) {
        if (context.runId !== runId) throw new Error(`MemoryRunModule for '${runId}' cannot execute a tool for Run '${context.runId}'`);
        return tool.execute(args, context);
      },
    })),
    ...(options.recall === undefined ? {} : { recall: options.recall }),
    apply: materialize,
    async restoreFromEvents(events) {
      const next = await store.rebuild(runId, memoryMutationsFromEvents(events, runId));
      options.retrieval?.syncState(next);
      return next;
    },
    projectContext: options.projectContext ?? ((memory) => cloneMemory(memory)),
    ...(options.close === undefined ? {} : { close: options.close }),
  };
}
