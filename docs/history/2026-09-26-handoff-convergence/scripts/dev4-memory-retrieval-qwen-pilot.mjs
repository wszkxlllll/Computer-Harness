#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { QwenTextEmbeddingProvider, HybridMemoryRecallService } from "../packages/memory/dist/retrieval/index.js";

const MAX_REQUESTS = 6;
const MAX_INPUT_CHARACTERS = 4_000;
const runId = "synthetic-qwen-retrieval-pilot";

function required(argv, name) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.trim().length === 0) throw new Error(`missing_${name.slice(2).replaceAll("-", "_")}`);
  return value;
}

function loadEnvText(text) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function safeErrorCode(error) {
  if (typeof error === "object" && error !== null && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)) return error.code;
  return "EMBEDDING_REQUEST_FAILED";
}

function syntheticFact(id, key, value, sequence, status = "active") {
  return {
    id,
    subject: { type: "run" },
    key,
    value,
    sourceEventId: `synthetic-${id}`,
    status,
    scope: { kind: "run" },
    retentionClass: "stable",
    updatedSequence: sequence,
  };
}

function syntheticState(facts) {
  return { runId, facts, entities: [] };
}

function syntheticQuery(originalGoal, explicitQuery) {
  return {
    runId,
    originalGoal,
    ...(explicitQuery === undefined ? {} : { explicitQuery }),
  };
}

function ranking(result) {
  return {
    admitted: result.admittedFacts.map((entry) => ({ id: entry.fact.id, match: entry.match })),
    revalidation: result.revalidationCandidates.map((entry) => ({ id: entry.fact.id, match: entry.match, reason: entry.reason })),
    excluded: result.excluded.map((entry) => ({ id: entry.id, reason: entry.reason })),
    semanticStatus: result.diagnostics.semanticStatus,
    semanticErrorCode: result.diagnostics.semanticErrorCode,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const envFile = required(argv, "--env-file");
  const envText = await readFile(envFile, "utf8");
  loadEnvText(envText);
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
  if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("missing_DASHSCOPE_API_KEY");
  if (workspaceId === undefined || workspaceId.trim().length === 0) throw new Error("missing_DASHSCOPE_WORKSPACE_ID");

  // This is the documented Beijing OpenAI-compatible endpoint. No fallback or
  // endpoint rotation is allowed in this pilot.
  const endpoint = `https://${workspaceId.trim()}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`;
  const baseProvider = new QwenTextEmbeddingProvider({ endpoint, apiKey, model: "text-embedding-v4", dimensions: 256 });
  let requestCount = 0;
  let inputCharacters = 0;
  const attempts = [];
  const usageTotals = [];
  const provider = {
    id: baseProvider.id,
    model: baseProvider.model,
    dimensions: baseProvider.dimensions,
    async embed(input, options) {
      requestCount += 1;
      inputCharacters += input.texts.reduce((sum, text) => sum + text.length, 0);
      if (requestCount > MAX_REQUESTS || inputCharacters > MAX_INPUT_CHARACTERS) {
        throw new Error("pilot_budget_exceeded");
      }
      try {
        const batch = await baseProvider.embed(input, options);
        attempts.push({ status: "ok", kind: input.kind });
        usageTotals.push(batch.usage?.totalTokens ?? null);
        return batch;
      } catch (error) {
        attempts.push({ status: "error", kind: input.kind, code: safeErrorCode(error) });
        throw error;
      }
    },
  };
  const service = new HybridMemoryRecallService(provider, { deadlineMs: 30_000, maxCandidates: 8, maxAdmittedFacts: 4, maxRevalidationFacts: 2 });
  const facts = [
    syntheticFact("invoice", "invoice_record", "The utility invoice is due next week.", 1),
    syntheticFact("meeting", "meeting_location", "会议地点在东侧教室。", 2),
    syntheticFact("recipe", "recipe_note", "这是一份番茄面食谱。", 3),
    syntheticFact("legacy-invoice", "legacy_invoice", "Old invoice record", 4, "superseded"),
  ];
  const memory = syntheticState(facts);
  const signal = new AbortController().signal;
  const results = [];
  const run = async (label, recallQuery) => {
    const result = await service.search(memory, recallQuery, signal);
    results.push({ label, ranking: ranking(result) });
    if (attempts.some((attempt) => attempt.status === "error")) throw new Error("pilot_first_error_stop");
  };
  try {
    await run("english-paraphrase", syntheticQuery("Find the bill deadline"));
    await run("exact-identifier", syntheticQuery("Locate the saved record", "invoice_record"));
    await run("chinese-paraphrase", syntheticQuery("查找会议地点"));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "error", requestCount, inputCharacters, attempts, usageTotals, code: safeErrorCode(error) }) + "\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify({ status: "ok", requestCount, inputCharacters, attempts, usageTotals, results }) + "\n");
}

main().catch((error) => {
  // Keep failures before provider construction safe as well.
  process.stdout.write(JSON.stringify({ status: "error", code: safeErrorCode(error) }) + "\n");
  process.exitCode = 2;
});
