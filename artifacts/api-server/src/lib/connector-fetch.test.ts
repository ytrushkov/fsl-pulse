import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  connectorFetch,
  ConnectorFetchError,
  parseRetryAfter,
  parseRateLimitReset,
} from "./connector-fetch";

// We're testing the rate-limit-aware retry semantics PRD §6.2 requires.
// Network is fully mocked via the `fetchImpl` test seam; SSRF is bypassed by
// pointing at a known-public host. Sleep is mocked to keep the suite fast
// while still exercising the real retry loop.

const PUBLIC_URL = "https://api.github.com/rate_limit";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("parseRetryAfter", () => {
  it("treats integer header as delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("treats HTTP-date header as absolute target", () => {
    const now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const future = new Date(now + 7_500).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(7_000);
  });
  it("ignores invalid / past headers", () => {
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter("")).toBe(0);
    expect(parseRetryAfter("not-a-date")).toBe(0);
    expect(parseRetryAfter("-3")).toBe(0);
  });
});

describe("parseRateLimitReset", () => {
  it("returns 0 when remaining > 0 (no exhaustion yet)", () => {
    const h = new Headers({
      "x-ratelimit-remaining": "47",
      "x-ratelimit-reset": "1735693200",
    });
    expect(parseRateLimitReset(h)).toBe(0);
  });
  it("returns absolute-epoch wait when remaining=0", () => {
    const now = 1_700_000_000_000;
    const reset = Math.floor(now / 1000) + 12;
    const h = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
    expect(parseRateLimitReset(h, now)).toBeGreaterThanOrEqual(11_000);
  });
});

describe("connectorFetch — rate-limit-aware retry (PRD §6.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retries 429 with Retry-After then returns evidence on success", async () => {
    // Conformance test: a real upstream rate-limits the first call with a
    // standards-compliant `Retry-After: 1`, then serves the request. The
    // wrapper MUST sleep the indicated window and retry rather than throw,
    // so the connector run still produces evidence.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ rate: { remaining: 4999 } }));

    const sleeps: number[] = [];
    const sleepImpl = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const r = await connectorFetch(PUBLIC_URL, { fetchImpl, sleepImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    const body = (await r.json()) as { rate: { remaining: number } };
    expect(body.rate.remaining).toBe(4999);
    // First sleep must be at least the upstream-requested window (1s),
    // proving we honored Retry-After rather than blasting the upstream
    // again on raw exponential backoff.
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
  });

  it("retries when X-RateLimit-Remaining=0 + Reset is set (no Retry-After)", async () => {
    // GitHub's documented behavior: 429 with no Retry-After but reset epoch
    // in X-RateLimit-Reset. The wrapper must derive a wait from those.
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 1;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const sleepImpl = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    const r = await connectorFetch(PUBLIC_URL, { fetchImpl, sleepImpl });
    expect(r.status).toBe(200);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx with capped exponential backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream broken", { status: 503 }))
      .mockResolvedValueOnce(new Response("upstream broken", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const sleepImpl = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    const r = await connectorFetch(PUBLIC_URL, {
      fetchImpl,
      sleepImpl,
      baseBackoffMs: 1,
      maxBackoffMs: 10,
    });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces ConnectorFetchError after exhausting retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("nope", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      );
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    await expect(
      connectorFetch(PUBLIC_URL, {
        fetchImpl,
        sleepImpl,
        maxRetries: 2,
        baseBackoffMs: 1,
        maxBackoffMs: 5,
      }),
    ).rejects.toBeInstanceOf(ConnectorFetchError);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("does not retry on non-retryable 4xx (e.g. 401 token rotation)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    const r = await connectorFetch(PUBLIC_URL, { fetchImpl, sleepImpl });
    expect(r.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("rejects SSRF targets before any fetch attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      connectorFetch("http://169.254.169.254/latest/meta-data/", { fetchImpl }),
    ).rejects.toThrow(/Refusing to call unsafe URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
