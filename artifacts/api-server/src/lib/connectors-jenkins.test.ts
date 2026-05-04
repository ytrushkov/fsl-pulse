import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyConnector, runConnector } from "./connectors";

// Connector-level conformance test (PRD §6.2 acceptance criterion).
// Asserts that an upstream 429 + Retry-After during a real connector
// run still results in successful evidence production — i.e. the runner
// path now goes through the shared `connectorFetch` retry loop instead
// of failing on the first rate-limit hit.
//
// We pick Jenkins because (a) it's the connector that was on raw fetch
// before this task and is most at risk of regression, and (b) its base
// URL is configurable, which lets us point it at any public hostname
// the SSRF guard accepts during a test. We use api.github.com as a
// stable public hostname.
//
// We deliberately do NOT mock `setTimeout` here — pino's thread-stream
// uses setTimeout for its async flush, so a synchronous override
// recurses unbounded. Instead, we use `Retry-After: 0` which keeps the
// wait window down to the random jittered backoff (≤1s on the first
// retry with default options). The exhausted-budget case is exercised
// by `connector-fetch.test.ts` with controlled backoff knobs.

const PUBLIC_BASE_URL = "https://api.github.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Jenkins connector — 429 conformance (PRD §6.2)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("verifyJenkins survives a 429+Retry-After then 200", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ nodeName: "primary", jobs: [{ name: "ci" }] }),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyConnector(
      "cicd",
      "jenkins",
      "fake-api-token",
      { baseUrl: PUBLIC_BASE_URL, username: "octocat" },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/octocat/);
    // Two attempts proves we did not bail on the first 429.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("runJenkins still produces evidence when first job-walk call is 429", async () => {
    const now = Date.now();
    const recentBuild = {
      number: 1,
      result: "SUCCESS",
      timestamp: now - 86_400_000,
      duration: 2 * 60_000,
    };
    const jobsResponse = jsonResponse({
      jobs: [{ name: "build", _class: "hudson.model.FreeStyleProject", builds: [recentBuild] }],
    });
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(jobsResponse);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runConnector(
      "cicd",
      "jenkins",
      "fake-api-token",
      { baseUrl: PUBLIC_BASE_URL, username: "octocat" },
    );

    // Evidence must still be produced — no "rate limited" gap row, real
    // deploy frequency derived from the (eventually-served) build data.
    expect(result.summary.provider).toBe("jenkins");
    expect(result.summary.builds30d).toBe(1);
    expect(result.summary.buildsSucceeded30d).toBe(1);
    expect(result.recordsCollected).toBeGreaterThanOrEqual(1);
    expect(result.evidence.length).toBeGreaterThan(0);
    // Two upstream calls: the 429, then the successful retry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
