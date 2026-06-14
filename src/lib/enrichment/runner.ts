/**
 * Enrichment execution runner.
 *
 * The original engine fired every row at once (`Promise.all` over all rows),
 * which detonates provider rate limits on any non-trivial CSV. This module
 * provides bounded-concurrency execution with retry/backoff and the helpers
 * needed to treat soft "Error:" string results as real failures.
 */

export interface EnrichmentSettings {
  /** Max simultaneous in-flight rows. */
  concurrency: number;
  /** Retry attempts per row on transient failure (0 = no retry). */
  maxRetries: number;
  /** Skip cells that already hold a non-empty, non-error value. */
  skipFilled: boolean;
}

export const DEFAULT_ENRICHMENT_SETTINGS: EnrichmentSettings = {
  concurrency: 5,
  maxRetries: 3,
  skipFilled: true,
};

const clampInt = (value: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

/** Read enrichment settings from localStorage with safe defaults. */
export const getEnrichmentSettings = (): EnrichmentSettings => {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_ENRICHMENT_SETTINGS };
  const concurrency = clampInt(
    Number(localStorage.getItem('enrichment_concurrency')),
    1,
    50,
    DEFAULT_ENRICHMENT_SETTINGS.concurrency,
  );
  const maxRetries = clampInt(
    Number(localStorage.getItem('enrichment_max_retries')),
    0,
    8,
    DEFAULT_ENRICHMENT_SETTINGS.maxRetries,
  );
  const skipRaw = localStorage.getItem('enrichment_skip_filled');
  const skipFilled = skipRaw === null ? DEFAULT_ENRICHMENT_SETTINGS.skipFilled : skipRaw === 'true';
  return { concurrency, maxRetries, skipFilled };
};

export const saveEnrichmentSettings = (settings: Partial<EnrichmentSettings>): void => {
  if (typeof localStorage === 'undefined') return;
  if (settings.concurrency !== undefined)
    localStorage.setItem('enrichment_concurrency', String(clampInt(settings.concurrency, 1, 50, 5)));
  if (settings.maxRetries !== undefined)
    localStorage.setItem('enrichment_max_retries', String(clampInt(settings.maxRetries, 0, 8, 3)));
  if (settings.skipFilled !== undefined)
    localStorage.setItem('enrichment_skip_filled', String(settings.skipFilled));
};

const TRANSIENT_PATTERN =
  /\b(429|408|425|500|502|503|504|rate.?limit|too many requests|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|failed to fetch|network ?error|socket hang up|overloaded|temporarily|try again)\b/i;

/** Does this thrown error look like a transient/retryable condition? */
export const isTransientError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return TRANSIENT_PATTERN.test(msg);
};

/**
 * Generated formulas swallow fetch errors and `return "Error: ..."` strings
 * instead of throwing, so successful-looking results are actually failures.
 * Detect those soft failures.
 */
export const looksLikeErrorResult = (value: string): boolean => {
  if (!value) return false;
  const v = value.trim();
  return (
    v === 'ERROR' ||
    /^error[:\s-]/i.test(v) ||
    /^please set your .* api key/i.test(v) ||
    /^please set (open ?ai|gemini|firecrawl)/i.test(v)
  );
};

/** A soft error result is retryable only if it names a transient cause. */
export const isRetryableResult = (value: string): boolean =>
  looksLikeErrorResult(value) && TRANSIENT_PATTERN.test(value);

/** Hard ceiling on a server-requested backoff so a bogus header can't hang a run. */
const RETRY_AFTER_CAP_MS = 120_000;

/**
 * Recover a server-requested backoff (ms) from an error/result string.
 * Honors an explicit `[retryAfterMs=N]` marker emitted by generated formulas,
 * a raw `Retry-After: <seconds>` header echo, or prose like "try again in 30s".
 * Returns null when no hint is present.
 */
export const parseRetryAfterMs = (text: unknown): number | null => {
  const s = text instanceof Error ? text.message : String(text ?? '');
  if (!s) return null;
  const marker = s.match(/\[retryAfterMs=(\d+)\]/i);
  if (marker) return Math.min(RETRY_AFTER_CAP_MS, Number(marker[1]));
  const header = s.match(/retry[-\s]?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i);
  if (header) {
    const n = Number(header[1]);
    const unit = (header[2] || 's').toLowerCase();
    return Math.min(RETRY_AFTER_CAP_MS, unit === 'ms' ? n : n * 1000);
  }
  const prose = s.match(/(?:try again|retry|wait)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|minutes?)/i);
  if (prose) {
    const n = Number(prose[1]);
    const unit = (prose[2] || 's').toLowerCase();
    const mult = unit === 'ms' ? 1 : unit.startsWith('m') && unit !== 'ms' ? 60_000 : 1000;
    return Math.min(RETRY_AFTER_CAP_MS, n * mult);
  }
  return null;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Inspect a resolved (non-throwing) value; return true to retry it. */
  shouldRetryResult?: (value: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, reason: unknown) => void;
  /** Honor a server-supplied Retry-After hint parsed from the error/result (default true). */
  respectRetryAfter?: boolean;
}

/**
 * Run `fn` with exponential backoff + full jitter. Retries on thrown
 * transient errors and on resolved values flagged by `shouldRetryResult`.
 */
export const withRetry = async <T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> => {
  const {
    maxRetries,
    baseDelayMs = 600,
    maxDelayMs = 20_000,
    signal,
    shouldRetryResult,
    onRetry,
    respectRetryAfter = true,
  } = opts;

  // Server-requested backoff wins over our computed jitter (capped in parseRetryAfterMs).
  const delayFor = (attempt: number, reason: unknown): number => {
    const computed = backoff(attempt, baseDelayMs, maxDelayMs);
    const hint = respectRetryAfter ? parseRetryAfterMs(reason) : null;
    return hint !== null ? Math.max(computed, hint) : computed;
  };

  let lastResult: T;
  for (let attempt = 0; ; attempt++) {
    try {
      lastResult = await fn();
      if (attempt < maxRetries && shouldRetryResult?.(lastResult)) {
        const delay = delayFor(attempt, lastResult);
        onRetry?.(attempt + 1, delay, lastResult);
        await sleep(delay, signal);
        continue;
      }
      return lastResult;
    } catch (error) {
      if (signal?.aborted) throw error;
      const retryable = attempt < maxRetries && isTransientError(error);
      if (!retryable) throw error;
      const delay = delayFor(attempt, error);
      onRetry?.(attempt + 1, delay, error);
      await sleep(delay, signal);
    }
  }
};

const backoff = (attempt: number, base: number, max: number): number => {
  const exp = Math.min(max, base * 2 ** attempt);
  // Full jitter: random in [base, exp] to de-correlate retry storms.
  return Math.round(base + Math.random() * Math.max(0, exp - base));
};

export interface ConcurrencyProgress {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface MapWithConcurrencyOptions {
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (progress: ConcurrencyProgress) => void;
}

/**
 * Map over `items` running at most `concurrency` workers at a time.
 * Preserves input order in the returned array. A worker that throws yields
 * `{ ok: false, error }`; otherwise `{ ok: true, value }`.
 */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> => {
  const { concurrency, signal, onProgress } = options;
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  const progress: ConcurrencyProgress = {
    completed: 0,
    total: items.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        results[index] = { ok: true, value };
        progress.succeeded++;
      } catch (error) {
        results[index] = { ok: false, error };
        progress.failed++;
      }
      progress.completed++;
      onProgress?.({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
};
