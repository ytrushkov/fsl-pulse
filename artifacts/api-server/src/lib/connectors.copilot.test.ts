import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnector, verifyConnector } from "./connectors";

// Tests for the GitHub Copilot ai_tooling sub-provider. We mock global fetch
// per-test so each scenario can shape billing/metrics responses independently
// without spinning up an HTTP server or relying on real GitHub credentials.

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response;

function installFetch(handler: FetchHandler) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return handler(url, init);
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const billingFixture = {
  seat_breakdown: {
    total: 100,
    added_this_cycle: 5,
    pending_invitation: 2,
    pending_cancellation: 1,
    active_this_cycle: 80,
    inactive_this_cycle: 20,
  },
  seat_management_setting: "assign_selected",
  public_code_suggestions: "allow",
};

const metricsFixture = [
  {
    date: "2026-04-25",
    total_active_users: 60,
    total_engaged_users: 50,
    copilot_ide_code_completions: {
      total_engaged_users: 50,
      languages: [
        { name: "typescript", total_engaged_users: 30 },
        { name: "python", total_engaged_users: 20 },
      ],
      editors: [
        {
          name: "vscode",
          total_engaged_users: 50,
          models: [
            {
              name: "default",
              is_custom_model: false,
              total_engaged_users: 50,
              languages: [
                {
                  name: "typescript",
                  total_engaged_users: 30,
                  total_code_suggestions: 1000,
                  total_code_acceptances: 300,
                  total_code_lines_suggested: 2000,
                  total_code_lines_accepted: 500,
                },
                {
                  name: "python",
                  total_engaged_users: 20,
                  total_code_suggestions: 500,
                  total_code_acceptances: 200,
                  total_code_lines_suggested: 1000,
                  total_code_lines_accepted: 350,
                },
              ],
            },
          ],
        },
      ],
    },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyConnector(ai_tooling, copilot)", () => {
  it("requires an organization in config", async () => {
    installFetch(() => {
      throw new Error("fetch should not be called when org is missing");
    });
    const r = await verifyConnector("ai_tooling", "copilot", "ghp_token", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/organization is required/i);
  });

  it("requires a token", async () => {
    installFetch(() => {
      throw new Error("fetch should not be called without token");
    });
    const r = await verifyConnector("ai_tooling", "copilot", "", { org: "acme" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/token required/i);
  });

  it("returns a clear scope message on 403 (missing manage_billing:copilot)", async () => {
    installFetch((url) => {
      expect(url).toBe("https://api.github.com/orgs/acme/copilot/billing");
      return errorResponse(403, { message: "Resource not accessible by integration" });
    });
    const r = await verifyConnector("ai_tooling", "copilot", "ghp_token", { org: "acme" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/403/);
    expect(r.message).toMatch(/manage_billing:copilot/);
  });

  it("returns a clear message on 404 (no Copilot subscription)", async () => {
    installFetch(() => errorResponse(404));
    const r = await verifyConnector("ai_tooling", "copilot", "ghp_token", { org: "acme" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/404/);
    expect(r.message).toMatch(/Copilot Business\/Enterprise/);
  });

  it("succeeds and reports seat counts on 200", async () => {
    installFetch((url) => {
      expect(url).toContain("/orgs/acme/copilot/billing");
      return jsonResponse(billingFixture);
    });
    const r = await verifyConnector("ai_tooling", "copilot", "ghp_token", { org: "acme" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/80\/100 seats active/);
    expect(r.details).toMatchObject({
      org: "acme",
      seatsTotal: 100,
      seatsActive: 80,
    });
  });

  it("encodes the org slug to prevent path injection", async () => {
    const seen: string[] = [];
    installFetch((url) => {
      seen.push(url);
      return jsonResponse(billingFixture);
    });
    await verifyConnector("ai_tooling", "copilot", "ghp_token", {
      org: "acme/../etc",
    });
    expect(seen[0]).toContain("acme%2F..%2Fetc");
    expect(seen[0]).not.toContain("acme/../etc");
  });
});

describe("runConnector(ai_tooling, copilot)", () => {
  it("emits a clear gap when the org is missing instead of crashing", async () => {
    installFetch(() => {
      throw new Error("fetch should not be called when org is missing");
    });
    const r = await runConnector("ai_tooling", "copilot", "ghp_token", {});
    expect(r.recordsCollected).toBe(0);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({
      dimension: "tooling",
      signalType: "gap",
    });
    expect(r.evidence[0].text).toMatch(/no organization specified/i);
  });

  it("emits a clear gap (not a thrown error) when the token lacks scope at run time", async () => {
    installFetch((url) => {
      if (url.endsWith("/copilot/billing")) return errorResponse(403);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const r = await runConnector("ai_tooling", "copilot", "ghp_token", { org: "acme" });
    expect(r.recordsCollected).toBe(0);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].signalType).toBe("gap");
    expect(r.evidence[0].text).toMatch(/manage_billing:copilot/);
    expect(r.summary).toMatchObject({ provider: "copilot", billingStatus: 403 });
  });

  it("emits seat utilization, DAU rate, acceptance, language breakdown on success", async () => {
    installFetch((url) => {
      if (url.endsWith("/copilot/billing")) return jsonResponse(billingFixture);
      if (url.endsWith("/copilot/metrics")) return jsonResponse(metricsFixture);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const r = await runConnector("ai_tooling", "copilot", "ghp_token", {
      org: "acme",
      engineerCount: 120,
    });

    // Summary numbers should be exact.
    expect(r.summary).toMatchObject({
      provider: "copilot",
      org: "acme",
      seatsTotal: 100,
      seatsActiveThisCycle: 80,
      seatUtilizationPct: 80,
      avgDailyActiveUsers: 60,
      dailyActiveUserRatePct: 50,
      totalSuggestions: 1500,
      totalAcceptances: 500,
      totalLinesSuggested: 3000,
      totalLinesAccepted: 850,
      acceptanceRatePct: 33.3,
    });

    // The four PRD-required evidence rows must all be present.
    const texts = r.evidence.map((e) => e.text);
    expect(texts.some((t) => /seat utilization: 80%/i.test(t))).toBe(true);
    expect(texts.some((t) => /daily-active-user rate/i.test(t))).toBe(true);
    expect(texts.some((t) => /suggestion acceptance: 33\.3%/i.test(t))).toBe(true);
    expect(texts.some((t) => /lines accepted vs suggested/i.test(t))).toBe(true);

    // Evidence must be tagged to People AND Tooling per the PRD.
    const dims = new Set(r.evidence.map((e) => e.dimension));
    expect(dims.has("people")).toBe(true);
    expect(dims.has("tooling")).toBe(true);

    // Language footprint should rank typescript above python (engaged-user-days).
    const langRow = r.evidence.find((e) => /language footprint/i.test(e.text));
    expect(langRow).toBeDefined();
    expect(langRow!.text).toMatch(/typescript \(30\).*python \(20\)/);
  });

  it("falls back to seat-based DAU when engineerCount is not provided", async () => {
    installFetch((url) => {
      if (url.endsWith("/copilot/billing")) return jsonResponse(billingFixture);
      if (url.endsWith("/copilot/metrics")) return jsonResponse(metricsFixture);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const r = await runConnector("ai_tooling", "copilot", "ghp_token", {
      org: "acme",
    });
    expect(r.summary).toMatchObject({
      dailyActiveUserRatePctOfSeats: 60,
    });
    expect(r.summary).not.toHaveProperty("dailyActiveUserRatePct");
    // And it should nudge the assessor to set engineerCount.
    expect(
      r.evidence.some((e) =>
        /Engineer count.*adoption %/i.test(e.text),
      ),
    ).toBe(true);
  });

  it("handles the metrics-404 case (privacy floor not met) without failing the run", async () => {
    installFetch((url) => {
      if (url.endsWith("/copilot/billing")) return jsonResponse(billingFixture);
      if (url.endsWith("/copilot/metrics")) return errorResponse(404);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const r = await runConnector("ai_tooling", "copilot", "ghp_token", {
      org: "acme",
      engineerCount: 50,
    });
    // Seat utilization still emitted from the billing call.
    expect(
      r.evidence.some((e) => /seat utilization/i.test(e.text)),
    ).toBe(true);
    // And a clear people-dimension gap explaining why DAU is missing.
    const gap = r.evidence.find(
      (e) => e.dimension === "people" && /privacy floor/i.test(e.text),
    );
    expect(gap?.signalType).toBe("gap");
  });
});
