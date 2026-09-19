import { describe, expect, it } from "vitest";
import type {
  ComputerSessionId,
  EventId,
  MemoryFact,
  MemoryState,
  RunId,
} from "@computer-harness/protocol";
import {
  HybridMemoryRecallService,
  QwenEmbeddingError,
  QwenTextEmbeddingProvider,
  type CurrentRecallQuery,
  type MemoryEmbeddingInput,
  type MemoryEmbeddingProvider,
} from "./index.js";

const runId = "retrieval-run" as RunId;
const sessionId = "retrieval-session" as ComputerSessionId;

function fact(
  id: string,
  key: string,
  value: string,
  updatedSequence: number,
  overrides: Partial<MemoryFact> = {},
): MemoryFact {
  return {
    id,
    subject: { type: "run" },
    key,
    value,
    sourceEventId: `event-${id}` as EventId,
    status: "active",
    scope: { kind: "run" },
    retentionClass: "stable",
    updatedSequence,
    ...overrides,
  };
}

function state(facts: readonly MemoryFact[], entities: MemoryState["entities"] = []): MemoryState {
  return { runId, facts: [...facts], entities: [...entities] };
}

function query(overrides: Partial<CurrentRecallQuery> = {}): CurrentRecallQuery {
  return { runId, originalGoal: "find the invoice", ...overrides };
}

class FakeEmbeddingProvider implements MemoryEmbeddingProvider {
  public readonly id = "fake";
  public readonly model = "fake-semantic-v1";
  public readonly dimensions = 2;
  public readonly calls: MemoryEmbeddingInput[] = [];
  public async embed(input: MemoryEmbeddingInput): Promise<{ vectors: readonly (readonly number[])[] }> {
    this.calls.push(input);
    return { vectors: input.texts.map((text) => fakeVector(text)) };
  }
}

function fakeVector(text: string): readonly number[] {
  const normalized = text.toLocaleLowerCase();
  if (normalized.includes("invoice") || normalized.includes("bill") || normalized.includes("账单")) return [1, 0];
  if (normalized.includes("recipe") || normalized.includes("食谱")) return [0, 1];
  return [1, 1];
}

function unitVector(dimensions: number, index: number): number[] {
  return Array.from({ length: dimensions }, (_, current) => current === index ? 1 : 0);
}

describe("Qwen text embedding adapter", () => {
  it("uses the explicit embeddings endpoint and restores shuffled indices", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 1, embedding: unitVector(256, 1) },
            { index: 0, embedding: unitVector(256, 0) },
          ],
          usage: { total_tokens: 12 },
        }),
      } as Response;
    };
    const provider = new QwenTextEmbeddingProvider({ endpoint: "https://embedding.example/v1/embeddings", apiKey: "synthetic-key", dimensions: 256, fetchImpl });
    await expect(provider.embed({ kind: "document", texts: ["账单", "食谱"] }, { signal: new AbortController().signal })).resolves.toMatchObject({
      vectors: [unitVector(256, 0), unitVector(256, 1)],
      usage: { totalTokens: 12 },
    });
    expect(requestUrl).toBe("https://embedding.example/v1/embeddings");
    expect(requestBody).toMatchObject({ model: "text-embedding-v4", dimensions: 256, encoding_format: "float", input: ["账单", "食谱"] });
  });

  it.each([
    ["duplicate index", [{ index: 0, embedding: unitVector(256, 0) }, { index: 0, embedding: unitVector(256, 1) }], "DUPLICATE_INDEX"],
    ["missing index", [{ index: 0, embedding: unitVector(256, 0) }, { embedding: unitVector(256, 1) }], "MISSING_INDEX"],
    ["wrong dimension", [{ index: 0, embedding: [1] }, { index: 1, embedding: unitVector(256, 1) }], "INVALID_DIMENSIONS"],
    ["zero vector", [{ index: 0, embedding: Array.from({ length: 256 }, () => 0) }, { index: 1, embedding: unitVector(256, 1) }], "ZERO_VECTOR"],
    ["non-finite vector", [{ index: 0, embedding: [Number.NaN, ...Array.from({ length: 255 }, () => 0)] }, { index: 1, embedding: unitVector(256, 1) }], "INVALID_VECTOR"],
  ])("rejects %s response data", async (_label, data, code) => {
    const fetchImpl: typeof fetch = async () => ({ ok: true, status: 200, json: async () => ({ data }) } as Response);
    const provider = new QwenTextEmbeddingProvider({ endpoint: "https://embedding.example/v1/embeddings", apiKey: "synthetic-key", dimensions: 256, fetchImpl });
    await expect(provider.embed({ kind: "document", texts: ["one", "two"] }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: `QWEN_EMBEDDING_${code}` } satisfies Partial<QwenEmbeddingError>);
  });

  it("rejects a response whose data count does not match the request batch", async () => {
    const fetchImpl: typeof fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: unitVector(256, 0) }] }) } as Response);
    const provider = new QwenTextEmbeddingProvider({ endpoint: "https://embedding.example/v1/embeddings", apiKey: "synthetic-key", dimensions: 256, fetchImpl });
    await expect(provider.embed({ kind: "document", texts: ["one", "two"] }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_EMBEDDING_INVALID_RESPONSE" });
  });

  it("enforces the documented maximum request batch before making HTTP", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response;
    };
    const provider = new QwenTextEmbeddingProvider({ endpoint: "https://embedding.example/v1/embeddings", apiKey: "synthetic-key", fetchImpl });
    await expect(provider.embed({ kind: "document", texts: Array.from({ length: 11 }, (_, index) => `text-${index}`) }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "QWEN_EMBEDDING_BATCH_LIMIT" });
    expect(calls).toBe(0);
  });
});

describe("HybridMemoryRecallService", () => {
  it("runs without a Plan and keeps exact identifiers available when semantics are disabled", async () => {
    const invoice = fact("invoice-fact", "invoice_file", "账单.pdf", 1);
    const recipe = fact("recipe-fact", "recipe_note", "食谱", 2);
    const service = new HybridMemoryRecallService();
    const result = await service.search(state([invoice, recipe]), query({ explicitQuery: "invoice_file" }), new AbortController().signal);
    expect(result.admittedFacts.map((item) => item.fact.id)).toEqual(["invoice-fact"]);
    expect(result.admittedFacts[0]?.match).toBe("exact");
    expect(result.diagnostics.semanticStatus).toBe("disabled");
    expect(result.diagnostics.querySources.explicitQuery).toBe(true);
  });

  it("preserves explicit query and newest correction when the goal exhausts the query budget", async () => {
    const explicit = fact("explicit-fact", "explicit_identifier", "explicit value", 1);
    const corrected = fact("correction-fact", "latest_correction_identifier", "corrected value", 2);
    const service = new HybridMemoryRecallService(undefined, { maxQueryCharacters: 64 });
    const result = await service.search(state([explicit, corrected]), query({
      originalGoal: "goal-noise-".repeat(80),
      explicitQuery: "explicit_identifier",
      latestUserCorrections: ["latest_correction_identifier"],
    }), new AbortController().signal);
    expect(result.admittedFacts.map((item) => item.fact.id)).toEqual(expect.arrayContaining(["explicit-fact", "correction-fact"]));
    expect(result.diagnostics.querySources).toMatchObject({
      explicitQuery: true,
      includedExplicitQuery: true,
      correctionCount: 1,
      includedCorrectionCount: 1,
      includedOriginalGoal: true,
    });
    expect(result.diagnostics.querySources.queryCharacterCount).toBeLessThanOrEqual(64);
  });

  it("matches exact fact identifiers without substring false positives", async () => {
    const target = fact("invoice-fact-42", "unrelated_key", "opaque value", 1);
    const service = new HybridMemoryRecallService();
    const exact = await service.search(state([target]), query({ originalGoal: "no lexical overlap", explicitQuery: "invoice-fact-42" }), new AbortController().signal);
    expect(exact.admittedFacts[0]).toMatchObject({ fact: { id: "invoice-fact-42" }, match: "exact" });
    const substring = await service.search(state([target]), query({ originalGoal: "no lexical overlap", explicitQuery: "invoice-fact-4" }), new AbortController().signal);
    expect(substring.admittedFacts).toHaveLength(0);
  });

  it("provides bounded English and Chinese lexical retrieval without a provider", async () => {
    const invoice = fact("invoice", "payment_note", "utility bill deadline next week", 1);
    const meeting = fact("meeting", "location_note", "会议地点在东侧教室", 2);
    const service = new HybridMemoryRecallService();
    const english = await service.search(state([invoice, meeting]), query({ originalGoal: "find the bill deadline" }), new AbortController().signal);
    const chinese = await service.search(state([invoice, meeting]), query({ originalGoal: "查找会议地点" }), new AbortController().signal);
    expect(english.admittedFacts[0]).toMatchObject({ fact: { id: "invoice" }, match: "lexical" });
    expect(chinese.admittedFacts[0]).toMatchObject({ fact: { id: "meeting" }, match: "lexical" });
    expect(english.diagnostics.actualMethod).toBe("lexical");
    expect(english.trace).toMatchObject({ method: "lexical", semanticStatus: "disabled", stateStable: true });
    expect(JSON.stringify(english.trace)).not.toContain("bill");
  });

  it("gates before semantic retrieval and separates revalidation candidates", async () => {
    const staleEntity = { id: "stale", type: "window", description: "old", sourceEventId: "entity-stale" as EventId, status: "stale" as const, updatedSequence: 1 };
    const active = fact("active", "active_fact", "账单", 1);
    const needsCheck = fact("needs-check", "needs_check_fact", "账单", 2, { status: "needs_check", statusReason: "manual_review" });
    const shortLived = fact("short", "short_fact", "账单", 3, { retentionClass: "short_lived" });
    const old = fact("old", "old_fact", "账单", 4, { status: "superseded" });
    const wrongSession = fact("wrong-session", "wrong_session_fact", "账单", 5, { scope: { kind: "computer_session", sessionId: "other-session" as ComputerSessionId } });
    const staleFact = fact("stale-fact", "stale_fact", "账单", 6, { subject: { type: "entity", entityId: "stale" } });
    const service = new HybridMemoryRecallService(new FakeEmbeddingProvider());
    const result = await service.search(state([active, needsCheck, shortLived, old, wrongSession, staleFact], [staleEntity]), query({ computerSessionId: sessionId, explicitQuery: "active_fact needs_check_fact short_fact" }), new AbortController().signal);
    expect(result.admittedFacts.map((item) => item.fact.id)).toContain("active");
    expect(result.admittedFacts.map((item) => item.fact.id)).not.toEqual(expect.arrayContaining(["needs-check", "short", "old", "wrong-session", "stale-fact"]));
    expect(result.revalidationCandidates.map((item) => item.fact.id)).toEqual(expect.arrayContaining(["needs-check", "short"]));
    expect(result.excluded).toEqual(expect.arrayContaining([
      { kind: "fact", id: "old", reason: "superseded" },
      { kind: "fact", id: "wrong-session", reason: "scope_mismatch" },
      { kind: "fact", id: "stale-fact", reason: "entity_stale" },
    ]));
  });

  it("uses dense semantic ranking for non-exact paraphrases and caches query/document vectors", async () => {
    const provider = new FakeEmbeddingProvider();
    const service = new HybridMemoryRecallService(provider);
    const invoice = fact("invoice", "payment_note", "invoice record", 1);
    const recipe = fact("recipe", "food_note", "recipe record", 2);
    const memory = state([invoice, recipe]);
    const first = await service.search(memory, query({ originalGoal: "find the bill" }), new AbortController().signal);
    expect(first.admittedFacts[0]).toMatchObject({ fact: { id: "invoice" }, match: "semantic" });
    expect(first.diagnostics.semanticStatus).toBe("used");
    const callCount = provider.calls.length;
    const second = await service.search(memory, query({ originalGoal: "find the bill" }), new AbortController().signal);
    expect(second.admittedFacts[0]?.fact.id).toBe("invoice");
    expect(second.diagnostics.embeddingRequestCount).toBe(0);
    expect(provider.calls).toHaveLength(callCount);
  });

  it("stops embedding after the per-run budget and keeps lexical fallback", async () => {
    const provider = new FakeEmbeddingProvider();
    const service = new HybridMemoryRecallService(provider, { maxEmbeddingRequestsPerRun: 1 });
    const memory = state([fact("invoice", "invoice_record", "invoice record", 1)]);
    const first = await service.search(memory, query({ originalGoal: "find the invoice" }), new AbortController().signal);
    const second = await service.search(memory, query({ originalGoal: "find the invoice" }), new AbortController().signal);
    expect(first.admittedFacts[0]?.fact.id).toBe("invoice");
    expect(first.diagnostics.embeddingRequestCount).toBe(1);
    expect(first.diagnostics.embeddingBudgetUsed).toBe(1);
    expect(first.diagnostics.semanticErrorCode).toBe("EMBEDDING_BUDGET_EXHAUSTED");
    expect(second.diagnostics.embeddingRequestCount).toBe(0);
    expect(second.diagnostics.embeddingBudgetUsed).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("separates cached vectors when the provider model or dimensions change", async () => {
    const provider = new FakeEmbeddingProvider();
    const service = new HybridMemoryRecallService(provider);
    const memory = state([fact("invoice", "payment_note", "invoice record", 1)]);
    await service.search(memory, query({ originalGoal: "find the bill" }), new AbortController().signal);
    const firstCallCount = provider.calls.length;
    (provider as unknown as { model: string }).model = "fake-semantic-v2";
    await service.search(memory, query({ originalGoal: "find the bill" }), new AbortController().signal);
    expect(provider.calls.length).toBeGreaterThan(firstCallCount);
  });

  it("does not cache a late vector after the fact revision changes", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    let deferredDocuments = 1;
    const provider: MemoryEmbeddingProvider = {
      id: "deferred",
      model: "deferred-v1",
      dimensions: 2,
      embed: async (input) => {
        calls += 1;
        if (input.kind === "query") return { vectors: [[1, 0]] };
        if (deferredDocuments === 0) return { vectors: input.texts.map((text) => fakeVector(text)) };
        deferredDocuments -= 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { vectors: input.texts.map((text) => fakeVector(text)) };
      },
    };
    const original = fact("fact", "note", "invoice", 1);
    const changed = fact("fact", "note", "recipe", 2);
    const service = new HybridMemoryRecallService(provider, { deadlineMs: 500 });
    const pending = service.search(state([original]), query({ originalGoal: "find a bill" }), new AbortController().signal);
    await Promise.resolve();
    service.syncState(state([changed]));
    release?.();
    const late = await pending;
    expect(late.admittedFacts).toHaveLength(0);
    expect(late.diagnostics.semanticResultCount).toBe(0);
    const next = await service.search(state([changed]), query({ originalGoal: "find a recipe" }), new AbortController().signal);
    expect(next.admittedFacts[0]?.fact.id).toBe("fact");
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("rejects a late result when an entity invalidates the canonical snapshot", async () => {
    let release: (() => void) | undefined;
    const provider: MemoryEmbeddingProvider = {
      id: "entity-deferred",
      model: "entity-deferred-v1",
      dimensions: 2,
      embed: async (input) => {
        if (input.kind === "query") return { vectors: [[1, 0]] };
        await new Promise<void>((resolve) => { release = resolve; });
        return { vectors: input.texts.map(() => [1, 0]) };
      },
    };
    const entity = { id: "window", type: "window", description: "synthetic", sourceEventId: "entity" as EventId, status: "active" as const, updatedSequence: 1 };
    const factWithEntity = fact("entity-fact", "note", "invoice", 1, { subject: { type: "entity", entityId: "window" } });
    const staleEntity = { ...entity, status: "stale" as const, updatedSequence: 2 };
    const service = new HybridMemoryRecallService(provider, { deadlineMs: 500 });
    const pending = service.search(state([factWithEntity], [entity]), query({ originalGoal: "find a bill" }), new AbortController().signal);
    await Promise.resolve();
    service.syncState(state([factWithEntity], [staleEntity]));
    release?.();
    const late = await pending;
    expect(late.admittedFacts).toHaveLength(0);
    expect(late.trace.stateStable).toBe(false);
    expect(late.diagnostics.semanticErrorCode).toBe("STATE_CHANGED_DURING_RECALL");
  });

  it("falls back to lexical results on a deadline and does not cache a non-cooperative response", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const provider: MemoryEmbeddingProvider = {
      id: "slow",
      model: "slow-v1",
      dimensions: 2,
      embed: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { vectors: [[1, 0]] };
      },
    };
    const service = new HybridMemoryRecallService(provider, { deadlineMs: 1 });
    const memory = state([fact("invoice", "invoice", "账单", 1)]);
    const first = await service.search(memory, query(), new AbortController().signal);
    expect(first.admittedFacts[0]?.match).toBe("exact");
    expect(first.diagnostics.semanticStatus).toBe("timed_out");
    const second = await service.search(memory, query(), new AbortController().signal);
    expect(second.diagnostics.embeddingRequestCount).toBe(1);
    expect(calls).toBe(2);
    release?.();
  });
});
