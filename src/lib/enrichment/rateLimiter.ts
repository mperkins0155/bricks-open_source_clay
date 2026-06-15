/**
 * Per-provider token-bucket rate limiter.
 *
 * Concurrency caps how many rows run at once; this caps the *request rate*
 * per upstream provider so a fast local machine doesn't burst straight into
 * a 429. When a provider does return a Retry-After, `penalizeProvider` pauses
 * the whole bucket — turning one row's rate-limit signal into fleet-wide
 * backoff (proactive pacing + reactive cooldown).
 */

export type ProviderKey = 'openai' | 'gemini' | 'ollama' | 'firecrawl' | 'puppeteer' | 'unknown';

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerSec: number;
  last: number;
  pausedUntil: number;
}

const buckets = new Map<ProviderKey, Bucket>();

const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** Default requests/min per provider. 0 = unlimited (local providers). */
const DEFAULT_RPM: Record<ProviderKey, number> = {
  openai: 60,
  gemini: 60,
  firecrawl: 20,
  ollama: 0,
  puppeteer: 0,
  unknown: 0,
};

export const isRateLimitEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem('rate_limit_enabled') !== 'false';
};

export const setRateLimitEnabled = (enabled: boolean): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('rate_limit_enabled', String(enabled));
};

const getProviderRpm = (key: ProviderKey): number => {
  if (typeof localStorage === 'undefined') return DEFAULT_RPM[key];
  const raw = localStorage.getItem(`rate_limit_${key}_rpm`);
  const n = raw === null ? DEFAULT_RPM[key] : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RPM[key];
};

const getBucket = (key: ProviderKey): Bucket | null => {
  const rpm = getProviderRpm(key);
  if (rpm <= 0) return null; // unlimited
  let b = buckets.get(key);
  const refillPerSec = rpm / 60;
  // Allow a small burst (~10s worth, min 1) so short columns aren't throttled.
  const capacity = Math.max(1, Math.min(rpm, Math.ceil(rpm / 6)));
  if (!b) {
    b = { tokens: capacity, capacity, refillPerSec, last: now(), pausedUntil: 0 };
    buckets.set(key, b);
  } else {
    // Pick up live config changes.
    b.capacity = capacity;
    b.refillPerSec = refillPerSec;
  }
  return b;
};

const refill = (b: Bucket): void => {
  const t = now();
  const elapsedSec = (t - b.last) / 1000;
  if (elapsedSec > 0) {
    b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillPerSec);
    b.last = t;
  }
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

/**
 * Block until a request token is available for `key`. Returns immediately
 * when rate limiting is disabled or the provider is unlimited.
 */
export const acquireRateToken = async (key: ProviderKey, signal?: AbortSignal): Promise<void> => {
  if (!isRateLimitEnabled()) return;
  const b = getBucket(key);
  if (!b) return;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const t = now();
    if (b.pausedUntil > t) {
      await sleep(Math.min(b.pausedUntil - t, 1000), signal);
      continue;
    }
    refill(b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    // Wait for the next token to accrue (bounded so we re-check pause state).
    const waitMs = Math.max(15, Math.min(1000, Math.ceil((1 - b.tokens) / b.refillPerSec * 1000)));
    await sleep(waitMs, signal);
  }
};

/** Pause a provider's bucket for `ms` (e.g. on a server Retry-After). */
export const penalizeProvider = (key: ProviderKey, ms: number): void => {
  if (ms <= 0) return;
  const b = getBucket(key);
  if (!b) return;
  b.pausedUntil = Math.max(b.pausedUntil, now() + ms);
  b.tokens = 0;
};

/** Reset all buckets (mainly for tests). */
export const __resetRateLimiter = (): void => buckets.clear();

/**
 * Infer which upstream provider a generated formula talks to, so we can pace
 * it. Detection is by endpoint/marker present in the generated code.
 */
export const detectFormulaProvider = (formula: string): ProviderKey => {
  if (!formula) return 'unknown';
  if (formula.includes('api.firecrawl.dev')) return 'firecrawl';
  if (formula.includes('/api/puppeteer')) return 'puppeteer';
  if (formula.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (formula.includes('api.openai.com')) return 'openai';
  // AI Copy Agents resolve provider at runtime; pace under openai by default
  // (the common cloud case) so multi-call rows don't burst.
  if (formula.includes('runAIAgents')) return 'openai';
  if (formula.includes('11434') || /localhost.*chat\/completions/.test(formula)) return 'ollama';
  return 'unknown';
};
