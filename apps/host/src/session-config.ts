import { resolve } from "node:path";
import { DEFAULT_DEEPSEEK_MAX_OUTPUT_TOKENS, DEFAULT_DEEPSEEK_REQUEST_TIMEOUT_MS, validateDeepseekMaxOutputTokens, validateDeepseekRequestTimeoutMs } from "@computer-harness/app-runtime";
import type { ApplicationSessionConfig, RunModel } from "@computer-harness/app-runtime";
import { parseGlmInputBudgets, parseGlmRequestTimeoutMs, readGlmThinking } from "./glm-output-budget.js";

export interface HostArguments {
  envFile: string;
  socket: string;
  model: RunModel;
  output: string;
  port: number;
  origins: string[];
  maxSteps: number;
  maxModelRequests: number;
  glmMaxOutputTokens: number;
}

export interface HostManagedBrowserProfileConfig {
  readonly profileLabel: string;
  readonly profileRoot: string;
}

export interface HostRunProfileSettings {
  readonly multilineTypeProfile?: HostCuaComputerConfig["multilineTypeProfile"];
  readonly operationGuidance?: "catalog-v1";
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
  return {
    ...(multilineTypeProfile === undefined ? {} : { multilineTypeProfile }),
    ...(operationGuidance === undefined ? {} : { operationGuidance }),
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
  const deepseekModel = args.model === "deepseek-flash";
  const arkModel = args.model === "deepseek-v4.1-flash";
  const deepseekRequestTimeoutMs = deepseekModel && env.DEEPSEEK_REQUEST_TIMEOUT_MS !== undefined
    ? Number(env.DEEPSEEK_REQUEST_TIMEOUT_MS.trim()) : DEFAULT_DEEPSEEK_REQUEST_TIMEOUT_MS;
  const deepseekMaxOutputTokens = deepseekModel && env.DEEPSEEK_MAX_OUTPUT_TOKENS !== undefined
    ? Number(env.DEEPSEEK_MAX_OUTPUT_TOKENS.trim()) : DEFAULT_DEEPSEEK_MAX_OUTPUT_TOKENS;
  validateDeepseekRequestTimeoutMs(deepseekRequestTimeoutMs);
  validateDeepseekMaxOutputTokens(deepseekMaxOutputTokens);
  const arkRequestTimeoutMs = arkModel && env.ARK_REQUEST_TIMEOUT_MS !== undefined
    ? Number(env.ARK_REQUEST_TIMEOUT_MS.trim()) : undefined;
  const arkMaxOutputTokens = arkModel && env.ARK_MAX_OUTPUT_TOKENS !== undefined
    ? Number(env.ARK_MAX_OUTPUT_TOKENS.trim()) : undefined;
  validateDeepseekRequestTimeoutMs(arkRequestTimeoutMs);
  validateDeepseekMaxOutputTokens(arkMaxOutputTokens);
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
    ...(qwenModel ? { contextMaxInputTokens: 8_000 } : deepseekModel || arkModel ? { contextMaxInputTokens: 16_384, contextMaxWireInputTokens: 24_576 } : parseGlmInputBudgets(env.GLM_MAX_INPUT_TOKENS, env.GLM_MAX_WIRE_INPUT_TOKENS)),
    ...(profileSettings.operationGuidance === undefined ? {} : { operationGuidance: profileSettings.operationGuidance }),
    riskProfile: "live-interactive",
    riskGuard: "layered",
    riskModel: "same",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 15_000,
    cleanupDeadlineMs: 5_000,
    // Keep no-progress evidence in the model context without automatically
    // blocking a phone-driven action while the interaction path is under test.
    monitor: "shadow",
    windowHandoff: "confirm-v1",
    ...(!deepseekModel && !arkModel ? {
      glmThinking: readGlmThinking(env.GLM_THINKING),
      glmMaxOutputTokens: args.glmMaxOutputTokens,
      glmRequestTimeoutMs: parseGlmRequestTimeoutMs(env.GLM_REQUEST_TIMEOUT_MS),
      ...(glmEndpoint === undefined ? {} : { glmEndpoint }),
    } : {}),
    ...(deepseekModel ? {
      deepseekRequestTimeoutMs,
      deepseekMaxOutputTokens,
      ...(env.DEEPSEEK_BASE_URL === undefined ? {} : { deepseekEndpoint: env.DEEPSEEK_BASE_URL }),
    } : {}),
    ...(arkModel ? {
      ...(arkRequestTimeoutMs === undefined ? {} : { arkRequestTimeoutMs }),
      ...(arkMaxOutputTokens === undefined ? {} : { arkMaxOutputTokens }),
      ...(env.ARK_BASE_URL === undefined ? {} : { arkEndpoint: env.ARK_BASE_URL }),
    } : {}),
    ...(baseUrl === undefined ? {} : { qwenEndpoint: baseUrl }),
    ...(env.DASHSCOPE_WORKSPACE_ID === undefined ? {} : { qwenWorkspaceId: env.DASHSCOPE_WORKSPACE_ID }),
    ...(qwenModel ? {
      qwenCoordinateMode: "normalized_1000" as const,
      qwenThinking: "low" as const,
      qwenOutputMode: "strict_json" as const,
    } : {}),
  };
}
