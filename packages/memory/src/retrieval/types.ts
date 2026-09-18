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
  /** A bounded deadline for one provider call. No retry is performed. */
  readonly deadlineMs?: number;
}

export type MemoryRetrievalMatch = "exact" | "semantic";

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

export interface MemoryRetrievalDiagnostics {
  readonly semanticStatus: MemorySemanticStatus;
  readonly querySources: {
    readonly originalGoal: boolean;
    readonly correctionCount: number;
    readonly explicitQuery: boolean;
    readonly actionHintCount: number;
  };
  readonly lexicalHitCount: number;
  readonly candidateCount: number;
  readonly semanticCandidateCount: number;
  readonly semanticResultCount: number;
  readonly omittedCandidateCount: number;
  readonly embeddingRequestCount: number;
  readonly embeddingCacheHits: number;
  readonly semanticErrorCode?: string;
}

export interface MemoryRetrievalResult {
  readonly admittedFacts: readonly RetrievedMemoryFact[];
  readonly revalidationCandidates: readonly RetrievedMemoryRevalidationCandidate[];
  readonly excluded: readonly MemoryRetrievalExcluded[];
  readonly diagnostics: MemoryRetrievalDiagnostics;
}
