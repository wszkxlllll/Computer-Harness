import type {
  ComputerSessionId,
  MemoryFact,
  RunId,
} from "@computer-harness/protocol";

/**
 * Inputs used to build a memory query.  `originalGoal` and user corrections
 * are authoritative context; the model query is only a retrieval refinement.
 * Action hints are intentionally optional and low-trust.  No field can widen
 * the run/session/status gate applied by the retrieval service.
 */
export interface CurrentRecallQuery {
  readonly runId: RunId;
  readonly computerSessionId?: ComputerSessionId;
  readonly originalGoal: string;
  readonly latestUserCorrections?: readonly string[];
  readonly explicitQuery?: string;
  readonly recentActionHints?: readonly string[];
}

export type MemoryEmbeddingKind = "query" | "document";

export interface MemoryEmbeddingInput {
  readonly kind: MemoryEmbeddingKind;
  readonly texts: readonly string[];
}

export interface MemoryEmbeddingBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly usage?: { readonly totalTokens: number };
}

/** Provider-neutral seam.  Implementations must not read process env values. */
export interface MemoryEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(input: MemoryEmbeddingInput, options: { readonly signal: AbortSignal }): Promise<MemoryEmbeddingBatch>;
}

export interface MemoryRetrievalLimits {
  readonly maxCandidates?: number;
  readonly maxAdmittedFacts?: number;
  readonly maxRevalidationFacts?: number;
  readonly maxExcluded?: number;
  readonly maxQueryCharacters?: number;
  readonly maxEmbeddingBatchSize?: number;
  readonly maxCachedVectors?: number;
  /** Maximum embedding HTTP attempts for this service/run. */
  readonly maxEmbeddingRequestsPerRun?: number;
  /** A bounded deadline for one provider call. No retry is performed. */
  readonly deadlineMs?: number;
}

export type MemoryRetrievalMatch = "exact" | "lexical" | "semantic";

export interface RetrievedMemoryFact {
  readonly fact: MemoryFact;
  /** Ranking score only; it is not a truth, confidence, or authorization signal. */
  readonly score: number;
  readonly match: MemoryRetrievalMatch;
}

export type MemoryRevalidationReason = "needs_check" | "short_lived_last_known";

export interface RetrievedMemoryRevalidationCandidate extends RetrievedMemoryFact {
  readonly reason: MemoryRevalidationReason;
}

export type MemoryRetrievalExclusionReason =
  | "superseded"
  | "scope_mismatch"
  | "entity_stale"
  | "entity_missing";

export interface MemoryRetrievalExcluded {
  readonly kind: "fact";
  readonly id: string;
  readonly reason: MemoryRetrievalExclusionReason;
}

export type MemorySemanticStatus = "used" | "disabled" | "not_needed" | "unavailable" | "timed_out";

export type MemoryRetrievalMethod = "lexical" | "hybrid";

export interface MemoryRetrievalTraceEntry {
  readonly id: string;
  readonly score: number;
  readonly match: MemoryRetrievalMatch;
  readonly reason?: MemoryRevalidationReason;
}

/** Safe retrieval trace: IDs, ranking metadata and bounded counters only. */
export interface MemoryRetrievalTrace {
  readonly method: MemoryRetrievalMethod;
  readonly semanticStatus: MemorySemanticStatus;
  readonly stateStable: boolean;
  readonly embeddingBudgetUsed: number;
  readonly embeddingBudgetLimit: number;
  readonly admitted: readonly MemoryRetrievalTraceEntry[];
  readonly revalidation: readonly MemoryRetrievalTraceEntry[];
  readonly excluded: readonly MemoryRetrievalExcluded[];
}

export interface MemoryRetrievalDiagnostics {
  readonly actualMethod: MemoryRetrievalMethod;
  readonly semanticStatus: MemorySemanticStatus;
  readonly querySources: {
    readonly originalGoal: boolean;
    readonly correctionCount: number;
    readonly explicitQuery: boolean;
    readonly actionHintCount: number;
    readonly includedOriginalGoal: boolean;
    readonly includedCorrectionCount: number;
    readonly includedExplicitQuery: boolean;
    readonly includedActionHintCount: number;
    readonly queryCharacterCount: number;
  };
  readonly lexicalHitCount: number;
  readonly candidateCount: number;
  readonly semanticCandidateCount: number;
  readonly semanticResultCount: number;
  readonly omittedCandidateCount: number;
  readonly embeddingRequestCount: number;
  readonly embeddingCacheHits: number;
  readonly embeddingBudgetUsed: number;
  readonly embeddingBudgetLimit: number;
  readonly stateStable: boolean;
  readonly semanticErrorCode?: string;
}

export interface MemoryRetrievalResult {
  readonly admittedFacts: readonly RetrievedMemoryFact[];
  readonly revalidationCandidates: readonly RetrievedMemoryRevalidationCandidate[];
  readonly excluded: readonly MemoryRetrievalExcluded[];
  readonly diagnostics: MemoryRetrievalDiagnostics;
  readonly trace: MemoryRetrievalTrace;
}
