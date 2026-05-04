import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runConnector } from "./connectors";

// PRD §6.2: assessors can disable expensive sub-pulls per connector. The
// runner must (a) skip the gated upstream calls, (b) emit `summary.activeFlags`
// reflecting the disabled set, and (c) NOT emit gap evidence for the
// signals it deliberately skipped — disabling a sub-pull is a "we are not
// measuring this", not a "this connector is missing data" event.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Connector feature flags — disabled flag must not penalize score", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("runGithub with pullIncidents=false skips incident search and emits no MTTR gap evidence", async () => {
    // Empty repos array means no DORA evidence from workflow/PR paths.
    // With pullWorkflows=false and pullPRs=false there should be exactly
    // one upstream call: the /orgs/{org}/repos enumeration.
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runConnector("github", "github", "fake-token", {
      org: "octo-org",
      featureFlags: {
        pullWorkflows: false,
        pullPRs: false,
        pullIncidents: false,
      },
    });

    // Exactly one upstream call — the gated sub-pulls were honored.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No "MTTR n/a" gap evidence row exists; the only thing that would
    // emit MTTR text is the gap fallback we just guarded.
    const mttrEvidence = result.evidence.filter((e) =>
      /MTTR/i.test(e.text),
    );
    expect(mttrEvidence).toHaveLength(0);

    // Summary explicitly marks MTTR as deliberately disabled rather than
    // returning 0 incidents (which the scoring engine would treat as a gap).
    expect(result.summary.mttrStatus).toBe("disabled");
    expect(result.summary.mttrHoursAvg).toBeNull();
    expect(result.summary.incidentIssues30d).toBeNull();

    // activeFlags is recorded so the run summary documents the assessor's
    // choice for downstream scoring + audit.
    const activeFlags = result.summary.activeFlags as Record<string, boolean>;
    expect(activeFlags.pullWorkflows).toBe(false);
    expect(activeFlags.pullPRs).toBe(false);
    expect(activeFlags.pullIncidents).toBe(false);
  });

  it("runGithub with pullIncidents=true emits the MTTR n/a gap when no incidents found", async () => {
    // Sanity check: when the assessor leaves the flag on but no incident-
    // labeled issues exist, we still surface the gap evidence we did
    // before. This proves the previous test's silence was caused by the
    // flag, not by the rewrite eating evidence wholesale.
    const fetchSpy = vi
      .fn<typeof fetch>()
      // /orgs/{org}/repos
      .mockResolvedValueOnce(jsonResponse([]))
      // 4 incident-label searches → all empty
      .mockResolvedValue(jsonResponse({ items: [] }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runConnector("github", "github", "fake-token", {
      org: "octo-org",
      featureFlags: {
        pullWorkflows: false,
        pullPRs: false,
        pullIncidents: true,
      },
    });

    const mttrEvidence = result.evidence.filter((e) =>
      /MTTR n\/a/i.test(e.text),
    );
    expect(mttrEvidence).toHaveLength(1);
    expect(result.summary.mttrStatus).toBeUndefined();
    expect(result.summary.mttrHoursAvg).toBeNull();
    expect(result.summary.incidentIssues30d).toBe(0);
  });
});
