export interface PostInputObservationSample<T> {
  readonly png: Uint8Array;
  readonly value: T;
}

export interface PostInputObservationSettlerOptions<T> {
  /** Monotonic timestamp when the foreground GUI dispatch completed or returned a known ambiguous outcome. */
  readonly inputCompletedAt: number;
  /** Capture callback for the current Computer scope; only its final value is returned. */
  readonly capture: () => Promise<PostInputObservationSample<T>>;
  readonly signal: AbortSignal;
  readonly wait: (durationMs: number, signal: AbortSignal) => Promise<void>;
  /** Private deterministic test seam; production uses performance.now(). */
  readonly now?: () => number;
  readonly minimumDelayMs?: number;
  readonly sampleIntervalMs?: number;
  readonly maximumElapsedMs?: number;
  readonly maximumSamples?: number;
  readonly requiredStableSamples?: number;
}

const DEFAULT_MINIMUM_DELAY_MS = 1_500;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_MAXIMUM_ELAPSED_MS = 3_000;
const DEFAULT_MAXIMUM_SAMPLES = 7;
const DEFAULT_REQUIRED_STABLE_SAMPLES = 2;

/**
 * Settle the next post-GUI-dispatch observation without creating additional Runtime
 * observations. Samples are private to Computer; callers receive only the
 * final frame. If the view keeps changing, return the latest captured frame at
 * the bounded deadline instead of treating animation as a capture failure.
 */
export async function settlePostInputObservation<T>(
  options: PostInputObservationSettlerOptions<T>,
): Promise<T> {
  const minimumDelayMs = options.minimumDelayMs ?? DEFAULT_MINIMUM_DELAY_MS;
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const maximumElapsedMs = options.maximumElapsedMs ?? DEFAULT_MAXIMUM_ELAPSED_MS;
  const maximumSamples = options.maximumSamples ?? DEFAULT_MAXIMUM_SAMPLES;
  const requiredStableSamples = options.requiredStableSamples ?? DEFAULT_REQUIRED_STABLE_SAMPLES;
  const now = options.now ?? (() => performance.now());

  if (!Number.isFinite(options.inputCompletedAt) || options.inputCompletedAt < 0 ||
      !Number.isFinite(minimumDelayMs) || minimumDelayMs < 0 ||
      !Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0 ||
      !Number.isFinite(maximumElapsedMs) || maximumElapsedMs < minimumDelayMs ||
      !Number.isSafeInteger(maximumSamples) || maximumSamples <= 0 ||
      !Number.isSafeInteger(requiredStableSamples) || requiredStableSamples < 2 || requiredStableSamples > maximumSamples) {
    throw new RangeError("post-input observation settling bounds are invalid");
  }

  const deadline = options.inputCompletedAt + maximumElapsedMs;
  let latest: PostInputObservationSample<T> | undefined;
  let previousPng: Uint8Array | undefined;
  let consecutiveStableSamples = 0;

  for (let index = 0; index < maximumSamples; index += 1) {
    if (index === 0) {
      const remainingMinimumDelay = options.inputCompletedAt + minimumDelayMs - now();
      if (remainingMinimumDelay > 0) {
        options.signal.throwIfAborted();
        await options.wait(remainingMinimumDelay, options.signal);
      }
    } else {
      const remainingUntilDeadline = deadline - now();
      if (remainingUntilDeadline <= 0) return latest!.value;
      options.signal.throwIfAborted();
      await options.wait(Math.min(sampleIntervalMs, remainingUntilDeadline), options.signal);
      if (now() >= deadline) return latest!.value;
    }

    options.signal.throwIfAborted();
    const sample = await options.capture();
    options.signal.throwIfAborted();
    latest = sample;

    if (previousPng !== undefined && sameBytes(previousPng, sample.png)) consecutiveStableSamples += 1;
    else consecutiveStableSamples = 1;
    if (consecutiveStableSamples >= requiredStableSamples) return sample.value;

    previousPng = sample.png;
    if (now() >= deadline || index + 1 >= maximumSamples) return sample.value;
  }

  return latest!.value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
