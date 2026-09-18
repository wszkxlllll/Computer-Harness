import { createHash } from "node:crypto";
import {
  isMemoryFactApplicable,
  isMemoryFactScopeApplicable,
  memoryFactRetentionClass,
  type MemoryFact,
  type MemoryState,
} from "@computer-harness/protocol";
import type {
  CurrentRecallQuery,
  MemoryEmbeddingBatch,
  MemoryEmbeddingProvider,
  MemoryRetrievalDiagnostics,
  MemoryRetrievalExcluded,
  MemoryRetrievalLimits,
  MemoryRetrievalResult,
  MemoryRetrievalTraceEntry,
  MemoryRevalidationReason,
  RetrievedMemoryFact,
  RetrievedMemoryRevalidationCandidate,
} from "./types.js";

const DEFAULT_LIMITS: Required<MemoryRetrievalLimits> = {
  maxCandidates: 32,
  maxAdmittedFacts: 8,
  maxRevalidationFacts: 4,
  maxExcluded: 32,
  maxQueryCharacters: 512,
  maxEmbeddingBatchSize: 10,
  maxCachedVectors: 256,
  maxEmbeddingRequestsPerRun: 6,
  deadlineMs: 750,
};

interface CachedVector {
  readonly providerKey: string;
  readonly revision: string;
  readonly vector: readonly number[];
}

interface RunIndex {
  readonly vectors: Map<string, CachedVector>;
  readonly queryVectors: Map<string, readonly number[]>;
  readonly revisions: Map<string, string>;
  stateRevision: string;
  embeddingRequests: number;
}

interface GatedFact {
  readonly fact: MemoryFact;
  readonly revalidationReason?: MemoryRevalidationReason;
}

type EmbeddingAttempt =
  | { readonly status: "ok"; readonly batch: MemoryEmbeddingBatch }
  | { readonly status: "timed_out" }
  | { readonly status: "unavailable"; readonly code: string };

/**
 * Gate-first hybrid Memory retrieval.  The index is deliberately an
 * in-process derived cache; MemoryState remains the source of truth and can
 * rebuild the cache after restart.  Call `syncState` after every committed
 * Memory mutation before allowing a new search.
 */
export class HybridMemoryRecallService {
  private readonly limits: Required<MemoryRetrievalLimits>;
  private readonly indexes = new Map<string, RunIndex>();

  public constructor(private readonly provider?: MemoryEmbeddingProvider, limits: MemoryRetrievalLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (this.limits.maxCandidates < 1 || this.limits.maxAdmittedFacts < 1 || this.limits.maxRevalidationFacts < 0 || this.limits.maxExcluded < 0) {
      throw new Error("Memory retrieval limits must be non-negative and bounded");
    }
    if (this.limits.maxQueryCharacters < 1 || this.limits.maxEmbeddingBatchSize < 1 || this.limits.maxEmbeddingBatchSize > 10 || this.limits.maxCachedVectors < 1 || this.limits.maxEmbeddingRequestsPerRun < 0 || this.limits.deadlineMs < 1) {
      throw new Error("Memory retrieval limits must be positive");
    }
  }

  /** Synchronize cache generations with the committed canonical state. */
  public syncState(state: MemoryState): void {
    const index = this.indexFor(state.runId);
    const providerKey = this.providerKey();
    const revisions = new Map<string, string>();
    for (const fact of state.facts) {
      const revision = factRevision(fact);
      revisions.set(fact.id, revision);
      const cached = index.vectors.get(fact.id);
      if (cached !== undefined && (cached.providerKey !== providerKey || cached.revision !== revision || fact.status === "superseded")) index.vectors.delete(fact.id);
    }
    for (const [factId] of index.vectors) {
      const fact = state.facts.find((candidate) => candidate.id === factId);
      if (fact === undefined || fact.status === "superseded") index.vectors.delete(factId);
    }
    index.revisions.clear();
    for (const [factId, revision] of revisions) index.revisions.set(factId, revision);
    index.stateRevision = stateRevision(state);
    this.boundVectorCache(index);
  }

  /**
   * Search a canonical snapshot.  No semantic provider is called until the
   * run/session/entity/status gate has removed inapplicable facts.
   */
  public async search(state: MemoryState, query: CurrentRecallQuery, signal: AbortSignal): Promise<MemoryRetrievalResult> {
    signal.throwIfAborted();
    this.syncState(state);
    const index = this.indexFor(state.runId);
    const snapshotRevision = index.stateRevision;
    const queryParts = buildQueryParts(query, this.limits.maxQueryCharacters);
    const gated = gateFacts(state, query);
    const excluded = gated.excluded.slice(0, this.limits.maxExcluded);
    const admitted = gated.admitted;
    const revalidation = gated.revalidation;
    const lexicalScores = new Map<string, number>();
    const exactAdmitted = new Set<string>();
    const exactRevalidation = new Set<string>();
    for (const item of [...admitted, ...revalidation]) {
      const score = lexicalScore(item.fact, queryParts.text);
      const exactIdentifier = hasExactIdentifier(item.fact, queryParts.text);
      if (score <= 0 && !exactIdentifier) continue;
      if (score > 0) lexicalScores.set(item.fact.id, score);
      if (exactIdentifier) {
        if (item.revalidationReason === undefined) exactAdmitted.add(item.fact.id);
        else exactRevalidation.add(item.fact.id);
      }
    }
    const lexicalHitCount = lexicalScores.size;
    const candidateFacts = [...admitted, ...revalidation]
      .sort((left, right) => {
        const leftScore = lexicalScores.get(left.fact.id) ?? 0;
        const rightScore = lexicalScores.get(right.fact.id) ?? 0;
        return rightScore - leftScore || right.fact.updatedSequence - left.fact.updatedSequence;
      });
    const semanticCandidates = candidateFacts.slice(0, this.limits.maxCandidates);
    const omittedCandidateCount = Math.max(0, candidateFacts.length - semanticCandidates.length);
    const vectors = new Map<string, readonly number[]>();
    for (const candidate of semanticCandidates) {
      const cached = index.vectors.get(candidate.fact.id);
      if (cached !== undefined && cached.providerKey === this.providerKey() && cached.revision === factRevision(candidate.fact)) vectors.set(candidate.fact.id, cached.vector);
    }

    let embeddingRequestCount = 0;
    let embeddingCacheHits = 0;
    let semanticStatus: MemoryRetrievalDiagnostics["semanticStatus"] = "not_needed";
    let semanticErrorCode: string | undefined;
    let queryVector: readonly number[] | undefined;
    let budgetExhausted = false;
    const consumeEmbeddingBudget = (): boolean => {
      if (index.embeddingRequests >= this.limits.maxEmbeddingRequestsPerRun) {
        budgetExhausted = true;
        semanticStatus = "unavailable";
        semanticErrorCode = "EMBEDDING_BUDGET_EXHAUSTED";
        return false;
      }
      index.embeddingRequests += 1;
      embeddingRequestCount += 1;
      return true;
    };
    if (this.provider === undefined) {
      semanticStatus = queryParts.text.length === 0 || semanticCandidates.length === 0 ? "not_needed" : "disabled";
    } else if (queryParts.text.length === 0 || semanticCandidates.length === 0) {
      semanticStatus = "not_needed";
    } else {
      const queryCacheKey = digest(JSON.stringify({
        runId: query.runId,
        sessionId: query.computerSessionId ?? null,
        provider: this.provider.id,
        model: this.provider.model,
        dimensions: this.provider.dimensions,
        query: queryParts.text,
      }));
      queryVector = index.queryVectors.get(queryCacheKey);
      if (queryVector !== undefined) {
        embeddingCacheHits += 1;
      } else {
        if (consumeEmbeddingBudget()) {
          const attempt = await this.requestEmbedding({ kind: "query", texts: [queryParts.text] }, signal);
          if (attempt.status === "ok") {
            queryVector = checkedVector(attempt.batch.vectors[0], this.provider.dimensions);
            if (queryVector !== undefined) index.queryVectors.set(queryCacheKey, queryVector);
            else {
              semanticStatus = "unavailable";
              semanticErrorCode = "EMBEDDING_VECTOR_INVALID";
            }
          } else {
            semanticStatus = attempt.status === "timed_out" ? "timed_out" : "unavailable";
            semanticErrorCode = attempt.status === "unavailable" ? attempt.code : "EMBEDDING_DEADLINE";
          }
        }
      }
      if (queryVector !== undefined && !budgetExhausted) {
        const missing = semanticCandidates.filter((candidate) => !vectors.has(candidate.fact.id));
        for (let offset = 0; offset < missing.length; offset += this.limits.maxEmbeddingBatchSize) {
          const batch = missing.slice(offset, offset + this.limits.maxEmbeddingBatchSize);
          if (!consumeEmbeddingBudget()) break;
          const attempt = await this.requestEmbedding({ kind: "document", texts: batch.map((item) => documentText(item.fact)) }, signal);
          if (attempt.status !== "ok") {
            semanticStatus = attempt.status === "timed_out" ? "timed_out" : "unavailable";
            semanticErrorCode = attempt.status === "unavailable" ? attempt.code : "EMBEDDING_DEADLINE";
            break;
          }
          if (attempt.batch.vectors.length !== batch.length) {
            semanticStatus = "unavailable";
            semanticErrorCode = "EMBEDDING_VECTOR_COUNT";
            break;
          }
          for (const [indexInBatch, candidate] of batch.entries()) {
            const vector = checkedVector(attempt.batch.vectors[indexInBatch], this.provider.dimensions);
            if (vector === undefined) {
              semanticStatus = "unavailable";
              semanticErrorCode = "EMBEDDING_VECTOR_INVALID";
              break;
            }
            const revision = factRevision(candidate.fact);
            if (this.indexFor(state.runId).revisions.get(candidate.fact.id) === revision) {
              vectors.set(candidate.fact.id, vector);
              this.indexFor(state.runId).vectors.set(candidate.fact.id, { providerKey: this.providerKey(), revision, vector });
            }
          }
          if (semanticStatus === "unavailable" || semanticStatus === "timed_out") break;
        }
        if (semanticStatus === "not_needed") semanticStatus = vectors.size > 0 ? "used" : "unavailable";
        else if (semanticStatus === "unavailable" || semanticStatus === "timed_out") {
          if (vectors.size > 0) semanticStatus = "used";
        } else {
          semanticStatus = vectors.size > 0 ? "used" : "unavailable";
        }
      }
    }

    const stateStable = index.stateRevision === snapshotRevision;
    if (!stateStable) {
      vectors.clear();
      queryVector = undefined;
      semanticStatus = "unavailable";
      semanticErrorCode = "STATE_CHANGED_DURING_RECALL";
    }
    const rankedAdmitted = rankFacts(stateStable ? admitted : [], vectors, queryVector, exactAdmitted, lexicalScores)
      .slice(0, this.limits.maxAdmittedFacts);
    const rankedRevalidation = rankFacts(stateStable ? revalidation : [], vectors, queryVector, exactRevalidation, lexicalScores)
      .slice(0, this.limits.maxRevalidationFacts)
      .map((item) => ({ ...item, reason: revalidation.find((candidate) => candidate.fact.id === item.fact.id)?.revalidationReason ?? "needs_check" }));
    this.boundVectorCache(index);
    const diagnostics: MemoryRetrievalDiagnostics = {
      actualMethod: this.provider === undefined ? "lexical" : "hybrid",
      semanticStatus,
      querySources: queryParts.sources,
      lexicalHitCount,
      candidateCount: candidateFacts.length,
      semanticCandidateCount: semanticCandidates.length,
      semanticResultCount: semanticCandidates.filter((candidate) => vectors.has(candidate.fact.id)).length,
      omittedCandidateCount,
      embeddingRequestCount,
      embeddingCacheHits,
      embeddingBudgetUsed: index.embeddingRequests,
      embeddingBudgetLimit: this.limits.maxEmbeddingRequestsPerRun,
      stateStable,
      ...(semanticErrorCode === undefined ? {} : { semanticErrorCode }),
    };
    const trace = {
      method: this.provider === undefined ? "lexical" : "hybrid",
      semanticStatus,
      stateStable,
      embeddingBudgetUsed: index.embeddingRequests,
      embeddingBudgetLimit: this.limits.maxEmbeddingRequestsPerRun,
      admitted: rankedAdmitted.map(traceEntry),
      revalidation: rankedRevalidation.map(traceEntry),
      excluded,
    } as const;
    return {
      admittedFacts: rankedAdmitted,
      revalidationCandidates: rankedRevalidation,
      excluded,
      diagnostics,
      trace,
    };
  }

  private async requestEmbedding(input: { readonly kind: "query" | "document"; readonly texts: readonly string[] }, signal: AbortSignal): Promise<EmbeddingAttempt> {
    if (this.provider === undefined) return { status: "unavailable", code: "EMBEDDING_DISABLED" };
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    const providerResult = this.provider.embed(input, { signal: controller.signal }).then(
      (batch) => ({ kind: "ok" as const, batch }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const deadline = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error("embedding deadline exceeded"));
        resolve({ kind: "timeout" });
      }, this.limits.deadlineMs);
    });
    let resolveCancellation: ((value: { readonly kind: "aborted" }) => void) | undefined;
    const cancellation = new Promise<{ readonly kind: "aborted" }>((resolve) => { resolveCancellation = resolve; });
    const onCancellation = (): void => resolveCancellation?.({ kind: "aborted" });
    signal.addEventListener("abort", onCancellation, { once: true });
    if (signal.aborted) onCancellation();
    const result = await Promise.race([providerResult, deadline, cancellation]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    removeAbortListener?.();
    signal.removeEventListener("abort", onCancellation);
    if (result.kind === "aborted") throw signal.reason;
    if (result.kind === "timeout") return { status: "timed_out" };
    if (result.kind === "error") return { status: "unavailable", code: embeddingErrorCode(result.error) };
    return { status: "ok", batch: result.batch };
  }

  private indexFor(runId: string): RunIndex {
    const current = this.indexes.get(runId);
    if (current !== undefined) return current;
    const created: RunIndex = { vectors: new Map(), queryVectors: new Map(), revisions: new Map(), stateRevision: "", embeddingRequests: 0 };
    this.indexes.set(runId, created);
    return created;
  }

  private providerKey(): string {
    return this.provider === undefined ? "disabled" : `${this.provider.id}:${this.provider.model}:${this.provider.dimensions}`;
  }

  private boundVectorCache(index: RunIndex): void {
    while (index.vectors.size > this.limits.maxCachedVectors) {
      const first = index.vectors.keys().next().value as string | undefined;
      if (first === undefined) break;
      index.vectors.delete(first);
    }
    while (index.queryVectors.size > this.limits.maxCachedVectors) {
      const first = index.queryVectors.keys().next().value as string | undefined;
      if (first === undefined) break;
      index.queryVectors.delete(first);
    }
  }
}

function gateFacts(state: MemoryState, query: CurrentRecallQuery): {
  readonly admitted: readonly GatedFact[];
  readonly revalidation: readonly GatedFact[];
  readonly excluded: readonly MemoryRetrievalExcluded[];
} {
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  const admitted: GatedFact[] = [];
  const revalidation: GatedFact[] = [];
  const excluded: MemoryRetrievalExcluded[] = [];
  for (const fact of state.facts) {
    if (fact.status === "superseded") {
      excluded.push({ kind: "fact", id: fact.id, reason: "superseded" });
      continue;
    }
    if (state.runId !== query.runId || !isMemoryFactScopeApplicable(fact, query.computerSessionId)) {
      excluded.push({ kind: "fact", id: fact.id, reason: "scope_mismatch" });
      continue;
    }
    if (!isMemoryFactApplicable(state, fact, query.computerSessionId)) {
      const entity = fact.subject.type === "entity" ? entityById.get(fact.subject.entityId) : undefined;
      excluded.push({ kind: "fact", id: fact.id, reason: entity === undefined ? "entity_missing" : "entity_stale" });
      continue;
    }
    if (fact.status === "needs_check") {
      revalidation.push({ fact, revalidationReason: "needs_check" });
    } else if (memoryFactRetentionClass(fact) === "short_lived") {
      revalidation.push({ fact, revalidationReason: "short_lived_last_known" });
    } else {
      admitted.push({ fact });
    }
  }
  return { admitted, revalidation, excluded };
}

function buildQueryParts(query: CurrentRecallQuery, maxCharacters: number): {
  readonly text: string;
  readonly sources: MemoryRetrievalDiagnostics["querySources"];
} {
  const corrections = (query.latestUserCorrections ?? []).map((value) => value.trim()).filter((value) => value.length > 0).slice(-4);
  const actionHints = (query.recentActionHints ?? []).map((value) => value.trim()).filter((value) => value.length > 0).slice(-2);
  const explicit = query.explicitQuery?.trim() ?? "";
  const goal = query.originalGoal.trim();
  const latestCorrection = corrections.at(-1) ?? "";
  const olderCorrections = corrections.slice(0, -1).reverse();
  const explicitBudget = explicit.length === 0 ? 0 : Math.max(1, Math.floor(maxCharacters * 0.45));
  const explicitReservation = Math.min(explicit.length, explicitBudget);
  const correctionBudget = latestCorrection.length === 0 ? 0 : Math.min(latestCorrection.length, Math.max(1, maxCharacters - explicitReservation - 1));
  const selected: Array<{ source: "explicit" | "goal" | "correction" | "action"; text: string }> = [];
  let remaining = maxCharacters;
  const append = (source: "explicit" | "goal" | "correction" | "action", value: string, budget = remaining): void => {
    if (value.length === 0 || remaining <= 0) return;
    const available = Math.min(remaining, Math.max(1, budget));
    const text = boundedQueryPart(value, available);
    if (text.length === 0) return;
    const separator = selected.length === 0 ? 0 : 1;
    const fitted = separator + text.length > remaining ? boundedQueryPart(text, Math.max(0, remaining - separator)) : text;
    if (fitted.length === 0) return;
    selected.push({ source, text: fitted });
    remaining -= separator + fitted.length;
  };
  // Reserve space for the explicit query and newest correction before the
  // long original goal can consume the bounded retrieval input.
  append("explicit", explicit, explicitBudget);
  append("correction", latestCorrection, correctionBudget);
  append("goal", goal);
  for (const correction of olderCorrections) append("correction", correction);
  for (const hint of actionHints) append("action", hint);
  const text = selected.map((part) => part.text).join("\n");
  const included = (source: "explicit" | "goal" | "correction" | "action"): number => selected.filter((part) => part.source === source).length;
  return {
    text,
    sources: {
      originalGoal: goal.length > 0,
      correctionCount: corrections.length,
      explicitQuery: explicit.length > 0,
      actionHintCount: actionHints.length,
      includedOriginalGoal: included("goal") > 0,
      includedCorrectionCount: included("correction"),
      includedExplicitQuery: included("explicit") > 0,
      includedActionHintCount: included("action"),
      queryCharacterCount: text.length,
    },
  };
}

function boundedQueryPart(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  if (maxCharacters === 1) return value.slice(-1);
  const tailLength = Math.max(1, Math.floor((maxCharacters - 1) / 2));
  const headLength = maxCharacters - 1 - tailLength;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function rankFacts(
  facts: readonly GatedFact[],
  vectors: ReadonlyMap<string, readonly number[]>,
  queryVector: readonly number[] | undefined,
  exactIds: ReadonlySet<string>,
  lexicalScores: ReadonlyMap<string, number>,
): RetrievedMemoryFact[] {
  return facts.map((candidate) => {
    const exact = exactIds.has(candidate.fact.id);
    const similarity = queryVector === undefined ? undefined : cosineSimilarity(queryVector, vectors.get(candidate.fact.id));
    const lexical = lexicalScores.get(candidate.fact.id) ?? 0;
    if (!exact && similarity === undefined && lexical <= 0) return undefined;
    const score = exact ? 2 + (similarity ?? lexical) : similarity ?? lexical;
    const match: RetrievedMemoryFact["match"] = exact ? "exact" : similarity === undefined ? "lexical" : "semantic";
    return { fact: candidate.fact, score, match } satisfies RetrievedMemoryFact;
  }).filter((item): item is RetrievedMemoryFact => item !== undefined).sort((left, right) => right.score - left.score || right.fact.updatedSequence - left.fact.updatedSequence);
}

function traceEntry(item: RetrievedMemoryFact | RetrievedMemoryRevalidationCandidate): MemoryRetrievalTraceEntry {
  return {
    id: item.fact.id,
    score: item.score,
    match: item.match,
    ...("reason" in item ? { reason: item.reason } : {}),
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[] | undefined): number | undefined {
  if (right === undefined || left.length !== right.length) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 || !Number.isFinite(denominator) ? undefined : dot / denominator;
}

function checkedVector(value: readonly number[] | undefined, dimensions: number): readonly number[] | undefined {
  if (value === undefined || value.length !== dimensions) return undefined;
  let norm = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) return undefined;
    norm += component * component;
  }
  return norm === 0 || !Number.isFinite(norm) ? undefined : [...value];
}

function documentText(fact: MemoryFact): string {
  const subject = fact.subject.type === "entity" ? ` entity:${fact.subject.entityId}` : "";
  return `key:${fact.key}${subject}\nvalue:${fact.value}`;
}

function hasExactIdentifier(fact: MemoryFact, queryText: string): boolean {
  const queryTokens = new Set(tokenizeLexical(queryText));
  const identifiers = [fact.id, fact.key, fact.sourceEventId, fact.subject.type === "entity" ? fact.subject.entityId : undefined]
    .filter((value): value is string => value !== undefined && value.trim().length >= 2)
    .map(normalize);
  return identifiers.some((identifier) => identifier.length >= 2 && queryTokens.has(identifier));
}

function lexicalScore(fact: MemoryFact, queryText: string): number {
  const queryTokens = new Set(tokenizeLexical(queryText));
  if (queryTokens.size === 0) return 0;
  const factTokens = new Set(tokenizeLexical(`${fact.key} ${fact.value}`));
  let overlap = 0;
  for (const token of queryTokens) if (factTokens.has(token)) overlap += 1;
  return overlap === 0 ? 0 : overlap / queryTokens.size;
}

function tokenizeLexical(value: string): readonly string[] {
  const normalized = normalize(value);
  const tokens: string[] = [];
  const ascii = normalized.match(/[a-z0-9][a-z0-9._:/-]*/gu) ?? [];
  tokens.push(...ascii);
  const cjk = normalized.match(/[\u3400-\u9fff]/gu) ?? [];
  tokens.push(...cjk);
  return [...new Set(tokens.filter((token) => token.length > 0))];
}

function factRevision(fact: MemoryFact): string {
  return digest(JSON.stringify({
    id: fact.id,
    subject: fact.subject,
    key: fact.key,
    value: fact.value,
    sourceEventId: fact.sourceEventId,
    status: fact.status,
    scope: fact.scope,
    retentionClass: fact.retentionClass,
    statusReason: fact.statusReason,
    updatedSequence: fact.updatedSequence,
  }));
}

function stateRevision(state: MemoryState): string {
  return digest(JSON.stringify({
    runId: state.runId,
    facts: state.facts,
    entities: state.entities,
  }));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function embeddingErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return "EMBEDDING_UNAVAILABLE";
}
