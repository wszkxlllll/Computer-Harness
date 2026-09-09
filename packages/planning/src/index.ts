import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  JsonValue,
  PlanState,
  PlanningTask,
  PlanningTaskMutation,
  PlanningTaskStatus,
  RunId,
  RuntimeEvent,
} from "@computer-harness/protocol";
import type { NonComputerToolDefinition } from "@computer-harness/runtime";

export type { PlanState, PlanningTask, PlanningTaskMutation, PlanningTaskStatus, TaskSpec } from "@computer-harness/protocol";

export interface PlanStore {
  get(runId: RunId): Promise<PlanState>;
  apply(runId: RunId, mutation: PlanningTaskMutation): Promise<PlanState>;
  rebuild(runId: RunId, mutations: readonly PlanningTaskMutation[]): Promise<PlanState>;
}

export class InMemoryPlanStore implements PlanStore {
  private readonly states = new Map<RunId, PlanState>();

  public async get(runId: RunId): Promise<PlanState> {
    return clonePlan(this.states.get(runId) ?? { runId, tasks: [] });
  }

  public async apply(runId: RunId, mutation: PlanningTaskMutation): Promise<PlanState> {
    const current = await this.get(runId);
    const next = applyMutation(current, mutation);
    this.states.set(runId, clonePlan(next));
    return clonePlan(next);
  }

  public async rebuild(runId: RunId, mutations: readonly PlanningTaskMutation[]): Promise<PlanState> {
    let plan: PlanState = { runId, tasks: [] };
    for (const mutation of mutations) plan = applyMutation(plan, mutation);
    this.states.set(runId, clonePlan(plan));
    return clonePlan(plan);
  }
}

export class FilePlanStore implements PlanStore {
  public constructor(private readonly rootDir: string) {}

  public async get(runId: RunId): Promise<PlanState> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(runId), "utf8")) as unknown;
      const plan = parsePlan(value);
      if (plan.runId !== runId) throw new Error("plan run id does not match requested run");
      validatePlanState(plan);
      return plan;
    } catch (error) {
      if (isFileNotFound(error)) return { runId, tasks: [] };
      throw error;
    }
  }

  public async apply(runId: RunId, mutation: PlanningTaskMutation): Promise<PlanState> {
    const current = await this.get(runId);
    const next = applyMutation(current, mutation);
    await this.writePlan(runId, next);
    return clonePlan(next);
  }

  public async rebuild(runId: RunId, mutations: readonly PlanningTaskMutation[]): Promise<PlanState> {
    let plan: PlanState = { runId, tasks: [] };
    for (const mutation of mutations) plan = applyMutation(plan, mutation);
    await this.writePlan(runId, plan);
    return clonePlan(plan);
  }

  private async writePlan(runId: RunId, plan: PlanState): Promise<void> {
    const path = this.pathFor(runId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private pathFor(runId: RunId): string {
    if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) throw new Error("invalid run id for PlanStore");
    return join(this.rootDir, runId, "plan.json");
  }
}

export function planningMutationsFromEvents(events: readonly RuntimeEvent[], runId: RunId): PlanningTaskMutation[] {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "planning.task.updated" }> => event.runId === runId && event.type === "planning.task.updated")
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => event.mutation);
}

export async function rebuildPlanFromEvents(store: PlanStore, runId: RunId, events: readonly RuntimeEvent[]): Promise<PlanState> {
  return store.rebuild(runId, planningMutationsFromEvents(events, runId));
}

export function createPlanningTools(store: PlanStore): readonly NonComputerToolDefinition[] {
  return [
    {
      name: "task_create",
      description: "Create one optional planning task for a handoff-sized phase of the current run. Use it at a phase boundary, when a real blocker appears, or when the goal changes—not for every click. The program generates a short stable task id (such as t1); wait for the result before calling task_update. The description should contain the phase goal and necessary unfinished work, not the full user task or reasoning.",
      category: "planning",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", minLength: 1, description: "Short task title." },
          description: { type: "string", description: "Optional details and completion intent." },
        },
        required: ["subject"],
        additionalProperties: false,
      },
      validate: (args) => validateTaskCreate(args),
      execute: async (args, context) => {
        const input = taskCreateArgs(args);
        const current = await store.get(context.runId);
        const task: PlanningTask = {
          id: nextTaskId(current),
          subject: input.subject,
          ...(input.description === undefined ? {} : { description: input.description }),
          status: "pending",
        };
        return { operation: "created", task } as unknown as JsonValue;
      },
      planMutationFromResult: (output) => readMutation(output),
      afterPlanCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    },
    {
      name: "task_update",
      description: "Update one existing planning task at a phase boundary, after a real blocker, or when the goal changes. Use the short id returned by task_create or task_list. Keep the description to the phase goal and necessary unfinished work; status is the model's declared planning state, not proof of GUI completion.",
      category: "planning",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", minLength: 1, description: "Existing task id returned by task_create or task_list." },
          subject: { type: "string", minLength: 1 },
          description: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
          blockedBy: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["taskId"],
        anyOf: [
          { required: ["subject"] },
          { required: ["description"] },
          { required: ["status"] },
          { required: ["blockedBy"] },
        ],
        additionalProperties: false,
      },
      validate: (args) => validateTaskUpdate(args),
      execute: async (args, context) => {
        const input = taskUpdateArgs(args);
        const state = await store.get(context.runId);
        const current = state.tasks.find((task) => task.id === input.taskId);
        if (current === undefined) throw new Error(`planning task ${input.taskId} does not exist`);
        const task: PlanningTask = {
          ...current,
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.blockedBy === undefined ? {} : { blockedBy: [...input.blockedBy] }),
        };
        // Validate references and dependency cycles before the mutation is
        // returned to Runtime; the committed event must never describe an
        // impossible PlanState.
        applyMutation(state, { operation: "updated", task });
        return { operation: "updated", task } as unknown as JsonValue;
      },
      planMutationFromResult: (output) => readMutation(output),
      afterPlanCommit: async (mutation, context) => { await store.apply(context.runId, mutation); },
    },
    {
      name: "task_list",
      description: "List the current run's optional phase tasks and declared status. Planning is not required for simple tasks.",
      category: "planning",
      audiences: ["main", "advisor"],
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      validate: (args) => validateEmptyObject(args, "task_list"),
      execute: async (_args, context) => ({ tasks: (await store.get(context.runId)).tasks }) as unknown as JsonValue,
    },
    {
      name: "task_get",
      description: "Read one current-run planning phase by its short id.",
      category: "planning",
      audiences: ["main", "advisor"],
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string", minLength: 1, description: "Existing planning task id." } },
        required: ["taskId"],
        additionalProperties: false,
      },
      validate: (args) => {
        taskIdArg(args);
      },
      execute: async (args, context) => {
        const taskId = taskIdArg(args);
        const task = (await store.get(context.runId)).tasks.find((item) => item.id === taskId);
        if (task === undefined) throw new Error(`planning task ${taskId} does not exist`);
        return { task } as unknown as JsonValue;
      },
    },
  ];
}

function validateTaskCreate(args: JsonValue): void {
  const input = taskCreateArgs(args);
  if (input.subject.trim().length === 0) throw new Error("task_create.subject must be non-empty");
}

function nextTaskId(plan: PlanState): string {
  let highest = 0;
  for (const task of plan.tasks) {
    const match = /^t([1-9][0-9]*)$/u.exec(task.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `t${highest + 1}`;
}

function validateTaskUpdate(args: JsonValue): void {
  const input = taskUpdateArgs(args);
  if (input.subject === undefined && input.description === undefined && input.status === undefined && input.blockedBy === undefined) {
    throw new Error("task_update requires at least one field to update");
  }
}

function validateEmptyObject(args: JsonValue, name: string): void {
  if (!isRecord(args) || Object.keys(args).length !== 0) throw new Error(`${name} accepts an empty object`);
}

function taskCreateArgs(args: JsonValue): { subject: string; description?: string } {
  assertAllowedKeys(args, "task_create", ["subject", "description"]);
  if (!isRecord(args) || typeof args.subject !== "string" || (args.description !== undefined && typeof args.description !== "string")) throw new Error("task_create requires subject and optional description");
  return { subject: args.subject, ...(args.description === undefined ? {} : { description: args.description }) };
}

function taskUpdateArgs(args: JsonValue): { taskId: string; subject?: string; description?: string; status?: PlanningTaskStatus; blockedBy?: string[] } {
  assertAllowedKeys(args, "task_update", ["taskId", "subject", "description", "status", "blockedBy"]);
  if (!isRecord(args) || typeof args.taskId !== "string" || args.taskId.length === 0) throw new Error("task_update requires taskId");
  if (args.subject !== undefined && (typeof args.subject !== "string" || args.subject.trim().length === 0)) throw new Error("task_update.subject must be a non-empty string");
  if (args.description !== undefined && typeof args.description !== "string") throw new Error("task_update.description must be a string");
  if (args.status !== undefined && !isPlanningStatus(args.status)) throw new Error("task_update.status is invalid");
  if (args.blockedBy !== undefined && (!Array.isArray(args.blockedBy) || args.blockedBy.some((item) => typeof item !== "string" || item.length === 0))) throw new Error("task_update.blockedBy must be non-empty task ids");
  return {
    taskId: args.taskId,
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.blockedBy === undefined ? {} : { blockedBy: [...args.blockedBy] as string[] }),
  };
}

function taskIdArg(args: JsonValue): string {
  assertAllowedKeys(args, "task_get", ["taskId"]);
  if (!isRecord(args) || typeof args.taskId !== "string" || args.taskId.length === 0) throw new Error("task_get requires taskId");
  return args.taskId;
}

function assertAllowedKeys(args: JsonValue, name: string, allowed: readonly string[]): void {
  if (!isRecord(args)) return;
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(args).find((key) => !allowedKeys.has(key));
  if (extra !== undefined) throw new Error(`${name} does not allow unknown field ${extra}`);
}

function readMutation(value: JsonValue): PlanningTaskMutation {
  if (!isRecord(value) || (value.operation !== "created" && value.operation !== "updated") || !isPlanningTask(value.task)) throw new Error("planning tool result has an invalid mutation");
  return { operation: value.operation, task: value.task };
}

function parsePlan(value: unknown): PlanState {
  if (!isRecord(value) || typeof value.runId !== "string" || !Array.isArray(value.tasks) || value.tasks.some((task) => !isPlanningTask(task))) throw new Error("plan.json has an invalid shape");
  return { runId: value.runId as RunId, tasks: value.tasks as unknown as PlanningTask[] };
}

function isPlanningTask(value: unknown): value is PlanningTask {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.subject !== "string" || !isPlanningStatus(value.status)) return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  return value.blockedBy === undefined || (Array.isArray(value.blockedBy) && value.blockedBy.every((item) => typeof item === "string"));
}

function isPlanningStatus(value: unknown): value is PlanningTaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked";
}

function clonePlan(plan: PlanState): PlanState {
  return { runId: plan.runId, tasks: plan.tasks.map((task) => ({ ...task, ...(task.blockedBy === undefined ? {} : { blockedBy: [...task.blockedBy] }) })) };
}

function applyMutation(plan: PlanState, mutation: PlanningTaskMutation): PlanState {
  const tasks = [...plan.tasks];
  const index = tasks.findIndex((task) => task.id === mutation.task.id);
  if (mutation.operation === "created") {
    if (index >= 0) {
      if (sameTask(tasks[index], mutation.task)) return clonePlan(plan);
      throw new Error(`planning task ${mutation.task.id} already exists during rebuild`);
    }
    tasks.push(mutation.task);
  } else {
    if (index < 0) throw new Error(`planning task ${mutation.task.id} does not exist during rebuild`);
    tasks[index] = mutation.task;
  }
  const next = { runId: plan.runId, tasks };
  validatePlanState(next);
  return next;
}

function sameTask(left: PlanningTask | undefined, right: PlanningTask): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function validatePlanState(plan: PlanState): void {
  const tasksById = new Map<string, PlanningTask>();
  for (const task of plan.tasks) {
    if (tasksById.has(task.id)) throw new Error(`planning task ${task.id} is duplicated`);
    tasksById.set(task.id, task);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.blockedBy ?? []) {
      if (dependency === task.id) throw new Error(`planning task ${task.id} cannot block itself`);
      if (!tasksById.has(dependency)) throw new Error(`planning task ${task.id} references missing blocker ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`planning task dependency cycle includes ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasksById.get(taskId)?.blockedBy ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of plan.tasks) visit(task.id);
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
