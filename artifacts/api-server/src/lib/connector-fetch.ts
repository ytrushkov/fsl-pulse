import { assertSafeUrlResolved } from "./util";
import { logger } from "./logger";

/**
 * Shared HTTP helper that every connector runner uses to talk to upstream
 * SaaS APIs. It exists so the platform can guarantee three things in one
 * place:
 *
 *  1. SSRF safety — `assertSafeUrlResolved` is invoked before every call so
 *     a hostile config can't redirect a privileged outbound request at the
 *     cloud metadata server or RFC1918 space.
 *  2. Rate-limit hygiene — 429 / 503 responses are inspected for
 *     `Retry-After` (seconds *or* HTTP-date) and `X-RateLimit-Remaining=0`
 *     paired with `X-RateLimit-Reset` (epoch seconds), and the wrapper
 *     sleeps for the indicated window before retrying. Without this, a
 *     bursty connector run will trip the upstream limit and lose the rest
 *     of its evidence collection.
 *  3. Capped exponential backoff for transient failures (5xx / network
 *     resets) so we don't hammer a degraded upstream — and so a single
 *     run can't stall forever waiting for a service that's down.
 *
 * The helper deliberately does *not* swallow non-retryable failures (4xx
 * other than 429): callers see them through `ConnectorFetchError` and
 * surface them as evidence gaps. 401 / 403 must fail loudly so the cockpit
 * can prompt the assessor to rotate the token.
 */

export interface ConnectorFetchOptions extends RequestInit {
  /** Maximum number of retry attempts after the initial request. Default 4. */
  maxRetries?: number;
  /** Hard cap on a single sleep between attempts (ms). Default 30s. */
  maxBackoffMs?: number;
  /** Base for exponential backoff (ms). Default 500. */
  baseBackoffMs?: number;
  /** Hard ceiling on the cumulative wait time across retries (ms). Default 90s. */
  maxTotalWaitMs?: number;
  /** Used for log correlation. */
  requestId?: string;
  /** Used for log correlation — emitted on every retry log line. */
  connectorLabel?: string;
  /**
   * Hook for tests: replaces the default `setTimeout`-backed sleep so retry
   * loops complete instantly without skipping the retry logic itself.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Override `globalThis.fetch` (test seam). */
  fetchImpl?: typeof fetch;
}

export class ConnectorFetchError extends Error {
  readonly status: number;
  readonly attempts: number;
  readonly url: string;
  readonly bodySnippet: string;
  constructor(opts: {
    message: string;
    status: number;
    attempts: number;
    url: string;
    bodySnippet?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "ConnectorFetchError";
    this.status = opts.status;
    this.attempts = opts.attempts;
    this.url = opts.url;
    this.bodySnippet = opts.bodySnippet ?? "";
  }
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_TOTAL_WAIT_MS = 90_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header into a wait duration in milliseconds.
 * Per RFC 9110 the value is either a non-negative integer (delta-seconds) or
 * an HTTP-date. Returns 0 for an absent / unparseable / past-date value so
 * the caller falls back to backoff.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number {
  if (!header) return 0;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (!Number.isFinite(secs) || secs < 0) return 0;
    return Math.floor(secs * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 0;
  return Math.max(0, dateMs - now);
}

/**
 * Inspect rate-limit hint headers (`X-RateLimit-Remaining=0` paired with
 * `X-RateLimit-Reset` as epoch seconds) and return the implied wait. Returns
 * 0 when not exhausted or the hint is unusable.
 */
export function parseRateLimitReset(
  headers: Headers,
  now: number = Date.now(),
): number {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (!remaining || !reset) return 0;
  if (Number(remaining) > 0) return 0;
  const resetSecs = Number(reset);
  if (!Number.isFinite(resetSecs) || resetSecs <= 0) return 0;
  // Heuristic: GitHub uses epoch-seconds. Some APIs report a relative
  // delta-seconds. If the value is small enough to be a delta, treat it
  // as one; otherwise treat it as an absolute epoch-seconds.
  if (resetSecs < 1_000_000_000) {
    return Math.floor(resetSecs * 1000);
  }
  return Math.max(0, Math.floor(resetSecs * 1000) - now);
}

function isRetryableStatus(status: number): boolean {
  // 408 Request Timeout, 425 Too Early are also worth retrying when
  // upstreams send them, but the common cases are 429 and 5xx.
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function expBackoffMs(
  attempt: number,
  base: number,
  cap: number,
): number {
  // Full-jitter: random in [0, min(cap, base * 2^attempt)). Avoids the
  // synchronized-thundering-herd that pure exponential delays cause when
  // many connectors hit the same upstream limit at once.
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

/**
 * Drop-in replacement for `fetch` that respects upstream rate limiting and
 * applies the SSRF guard. Throws `ConnectorFetchError` after the retry
 * budget is exhausted; otherwise returns a `Response` object that callers
 * may consume normally.
 *
 * Non-retryable error responses (4xx other than 408/425/429) are returned
 * to the caller for them to inspect — the wrapper does not throw on a 401
 * / 403 / 404 because those carry information the caller may want to
 * surface as evidence rather than as a hard failure.
 */
export async function connectorFetch(
  url: string,
  init: ConnectorFetchOptions = {},
): Promise<Response> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxTotalWaitMs = DEFAULT_MAX_TOTAL_WAIT_MS,
    requestId,
    connectorLabel,
    sleepImpl = defaultSleep,
    fetchImpl,
    ...rest
  } = init;

  await assertSafeUrlResolved(url);
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);

  let attempt = 0;
  let totalWait = 0;
  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  while (attempt <= maxRetries) {
    let resp: Response | null = null;
    try {
      resp = await doFetch(url, rest);
    } catch (err) {
      // Network-level failure (DNS, ECONNRESET, etc). Treated as retryable
      // up to the budget; otherwise surfaced.
      lastError = err;
      logger.warn(
        {
          err,
          url,
          attempt,
          requestId,
          connector: connectorLabel,
        },
        "connectorFetch: network error",
      );
      attempt += 1;
      if (attempt > maxRetries) break;
      const wait = expBackoffMs(attempt, baseBackoffMs, maxBackoffMs);
      if (totalWait + wait > maxTotalWaitMs) break;
      totalWait += wait;
      await sleepImpl(wait);
      continue;
    }

    lastResponse = resp;
    if (!isRetryableStatus(resp.status)) {
      return resp;
    }

    // Retryable. Decide how long to wait before the next attempt.
    const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
    const rateLimitReset = parseRateLimitReset(resp.headers);
    const hint = Math.max(retryAfter, rateLimitReset);
    const backoff = expBackoffMs(attempt + 1, baseBackoffMs, maxBackoffMs);
    let wait = Math.max(hint, backoff);
    wait = Math.min(wait, maxBackoffMs);
    attempt += 1;
    if (attempt > maxRetries) break;
    if (totalWait + wait > maxTotalWaitMs) {
      logger.warn(
        {
          url,
          attempt,
          requestId,
          connector: connectorLabel,
          status: resp.status,
          totalWait,
          maxTotalWaitMs,
        },
        "connectorFetch: hit total wait budget; surfacing failure",
      );
      break;
    }
    totalWait += wait;
    logger.info(
      {
        url,
        attempt,
        wait,
        status: resp.status,
        retryAfter,
        rateLimitReset,
        requestId,
        connector: connectorLabel,
      },
      "connectorFetch: retrying after rate-limit / transient failure",
    );
    // Drain the body so the underlying agent can release the socket
    // before we sleep.
    try {
      await resp.arrayBuffer();
    } catch {
      /* ignore */
    }
    await sleepImpl(wait);
  }

  // Budget exhausted. Surface a structured error with the last response /
  // network error context so the runner can record it as a critical event.
  if (lastResponse) {
    let bodySnippet = "";
    try {
      const txt = await lastResponse.text();
      bodySnippet = txt.slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new ConnectorFetchError({
      message: `Upstream ${lastResponse.status} after ${attempt} attempts`,
      status: lastResponse.status,
      attempts: attempt,
      url,
      bodySnippet,
    });
  }
  throw new ConnectorFetchError({
    message: `Network error after ${attempt} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    status: 0,
    attempts: attempt,
    url,
    cause: lastError,
  });
}

/**
 * Convenience: fetch + JSON-parse. Throws `ConnectorFetchError` for a
 * non-OK terminal response (after retries). Use this when the caller does
 * not need to inspect the raw response.
 */
export async function connectorFetchJson<T>(
  url: string,
  init: ConnectorFetchOptions = {},
): Promise<T> {
  const r = await connectorFetch(url, init);
  if (!r.ok) {
    let snippet = "";
    try {
      snippet = (await r.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new ConnectorFetchError({
      message: `Upstream ${r.status}: ${snippet || r.statusText}`,
      status: r.status,
      attempts: 1,
      url,
      bodySnippet: snippet,
    });
  }
  return (await r.json()) as T;
}
