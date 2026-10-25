import { resolve } from "node:path";
import type { ApplicationSessionConfig, RunModel } from "@computer-harness/app-runtime";
import { parseProviderRecoverySettings } from "@computer-harness/app-runtime";
import { parseGlmInputBudgets, parseGlmRequestTimeoutMs, readGlmThinking } from "./glm-output-budget.js";

export interface HostArguments {
  envFile: string;
  socket: string;
  model: "glm-5.3-flash" | "qwen3.8-flash";
  output: string;
  port: number;
  origins: string[];
  maxSteps: number;
  maxModelRequests: number;
  riskMaxModelRequests?: number;
  riskTimeoutMs?: number;
  glmMaxOutputTokens: number;
}

export const DEFAULT_HOST_RISK_MAX_MODEL_REQUESTS = 1;
export const MAX_HOST_RISK_MAX_MODEL_REQUESTS = 12;
export const DEFAULT_HOST_RISK_TIMEOUT_MS = 15_000;
export const MAX_HOST_RISK_TIMEOUT_MS = 240_000;

/** Explicit Host-local deadline; a timeout still requires approval. */
export function parseHostRiskTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_HOST_RISK_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_HOST_RISK_TIMEOUT_MS) {
    throw new Error(`--risk-timeout-ms must be an integer from 1000 to ${MAX_HOST_RISK_TIMEOUT_MS}.`);
  }
  return value;
}

/** Parse the explicit CLI-only semantic review request bound. */
export function parseHostRiskMaxModelRequests(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_HOST_RISK_MAX_MODEL_REQUESTS);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HOST_RISK_MAX_MODEL_REQUESTS) {
    throw new Error(`--risk-max-model-requests must be an integer from 1 to ${MAX_HOST_RISK_MAX_MODEL_REQUESTS}.`);
  }
  return value;
}

export interface HostManagedBrowserProfileConfig {
  readonly profileLabel: string;
  readonly profileRoot: string;
}

export interface HostRunProfileSettings {
  readonly multilineTypeProfile?: HostCuaComputerConfig["multilineTypeProfile"];
  readonly operationGuidance?: "catalog-v1";
  readonly providerRecovery: "off" | "ambiguous-headers-once-v1";
  readonly providerRecoveryRunWindowMs: number;
}

type HostCuaComputerConfig = Extract<ApplicationSessionConfig["computer"], { kind: "cua" }>;

/** Read only the explicit Host-local opt-ins; never infer them from socket or driver identity. */
export function resolveHostRunProfileSettings(env: NodeJS.ProcessEnv): HostRunProfileSettings {
  const rawMultilineTypeProfile = env.HARNESS_MULTILINE_TYPE_PROFILE;
  let multilineTypeProfile: HostRunProfileSettings["multilineTypeProfile"];
  if (rawMultilineTypeProfile === undefined || rawMultilineTypeProfile === "off") {
    multilineTypeProfile = undefined;
  } else if (rawMultilineTypeProfile === "foreground-caret-v1") {
    multilineTypeProfile = rawMultilineTypeProfile;
  } else {
    throw new Error("HARNESS_MULTILINE_TYPE_PROFILE must be off or foreground-caret-v1.");
  }

  const rawOperationGuidance = env.HARNESS_OPERATION_GUIDANCE;
  let operationGuidance: HostRunProfileSettings["operationGuidance"];
  if (rawOperationGuidance === undefined || rawOperationGuidance === "off") {
    operationGuidance = undefined;
  } else if (rawOperationGuidance === "catalog-v1") {
    operationGuidance = rawOperationGuidance;
  } else {
    throw new Error("HARNESS_OPERATION_GUIDANCE must be off or catalog-v1.");
  }
  const providerRecovery = parseProviderRecoverySettings(env);
  return {
    ...(multilineTypeProfile === undefined ? {} : { multilineTypeProfile }),
    ...(operationGuidance === undefined ? {} : { operationGuidance }),
    ...providerRecovery,
  };
}

/** Host base Run configuration. Phone-selected Run features cannot set these profile defaults. */
export function createHostSessionConfig(
  args: HostArguments,
  outputDir: string,
  managedBrowserProfile: HostManagedBrowserProfileConfig,
  env: NodeJS.ProcessEnv = process.env,
): ApplicationSessionConfig {
  const model: RunModel = args.model;
  const qwenModel = args.model === "qwen3.8-flash";
  const baseUrl = env.DASHSCOPE_BASE_URL ?? env.DASHSCOPE_ENDPOINT;
  const glmEndpoint = env.GLM_BASE_URL;
  const profileSettings = resolveHostRunProfileSettings(env);
  return {
    model,
    computer: {
      kind: "cua",
      socketPath: args.socket,
      screenshotDir: resolve(outputDir, "driver-screenshots"),
      grounding: "off",
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: managedBrowserProfile.profileLabel,
      managedBrowserProfileRoot: managedBrowserProfile.profileRoot,
      ...(profileSettings.multilineTypeProfile === undefined ? {} : { multilineTypeProfile: profileSettings.multilineTypeProfile }),
    },
    outputDir,
    maxSteps: args.maxSteps,
    maxModelRequests: args.maxModelRequests,
    planning: true,
    memory: "facts",
    memoryRetrieval: "lexical",
    batching: "same-control-input-v1",
    contextMode: "recent",
    contextMaxHistoryEvents: 32,
    ...(qwenModel ? { contextMaxInputTokens: 8_000 } : parseGlmInputBudgets(env.GLM_MAX_INPUT_TOKENS, env.GLM_MAX_WIRE_INPUT_TOKENS)),
    ...(profileSettings.operationGuidance === undefined ? {} : { operationGuidance: profileSettings.operationGuidance }),
    riskProfile: "live-interactive",
    riskGuard: "layered",
    riskModel: "same",
    riskMaxModelRequests: args.riskMaxModelRequests ?? DEFAULT_HOST_RISK_MAX_MODEL_REQUESTS,
    riskTimeoutMs: parseHostRiskTimeoutMs(args.riskTimeoutMs === undefined ? undefined : String(args.riskTimeoutMs)),
    cleanupDeadlineMs: 5_000,
    // Keep no-progress evidence in the model context without automatically
    // blocking a phone-driven action while the interaction path is under test.
    monitor: "shadow",
    windowHandoff: "confirm-v1",
    glmThinking: readGlmThinking(env.GLM_THINKING),
    glmMaxOutputTokens: args.glmMaxOutputTokens,
    glmRequestTimeoutMs: parseGlmRequestTimeoutMs(env.GLM_REQUEST_TIMEOUT_MS),
    providerRecovery: profileSettings.providerRecovery,
    providerRecoveryRunWindowMs: profileSettings.providerRecoveryRunWindowMs,
    ...(glmEndpoint === undefined ? {} : { glmEndpoint }),
    ...(baseUrl === undefined ? {} : { qwenEndpoint: baseUrl }),
    ...(env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { qwenWorkspaceId: env.DASHSCOPE_WORKSPACE_ID }),
    ...(qwenModel ? {
      qwenCoordinateMode: "normalized_1000" as const,
      qwenThinking: "low" as const,
      qwenOutputMode: "strict_json" as const,
    } : {}),
  };
}
