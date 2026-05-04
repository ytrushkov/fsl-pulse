/**
 * CI/CD connector verify-harness regression.
 *
 * Pins the contract every CI/CD sub-provider must satisfy:
 *   - verifyConnector("cicd", <provider>, ...) returns { ok: true } against a
 *     well-formed authenticated response and { ok: false } with a useful
 *     message against an auth failure.
 *   - runConnector("cicd", <provider>, ...) returns DORA-style summary keys
 *     (deploysPerDay, changeFailureRate) plus evidence rows tagged on the
 *     same dimensions, so the scoring engine can read across providers.
 *
 * `fetch` is mocked with recorded responses for each provider so this suite
 * never touches the network. New CI/CD providers should be added to the
 * `cases` table at the bottom — that is the whole point of the harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stub DNS so the SSRF guard's `assertSafeUrlResolved` doesn't try to resolve
// example.com against the real network. We pin every host to a public-looking
// IPv4 so the resolved-address check returns ok.
vi.mock("node:dns", async (importActual) => {
  const actual = await importActual<typeof import("node:dns")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
    },
  };
});

import { runConnector, verifyConnector } from "./connectors";

type RecordedResponse = {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
};

function mockFetchWith(responses: RecordedResponse[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const recorded = responses.find((r) => r.match(url));
      if (!recorded) {
        throw new Error(`Unexpected fetch in test: ${url}`);
      }
      const status = recorded.status ?? 200;
      return new Response(JSON.stringify(recorded.body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Pin "now" so the lookback windows are deterministic in fixtures below.
const FIXED_NOW = new Date("2026-04-15T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

describe("Jenkins CI/CD connector", () => {
  describe("verifyJenkins", () => {
    it("returns ok with the authenticated username on a healthy controller", async () => {
      mockFetchWith([
        {
          match: (u) => u === "https://jenkins.example.com/api/json",
          body: { nodeName: "main", jobs: [{ name: "deploy" }, { name: "build" }] },
        },
      ]);
      const result = await verifyConnector("cicd", "jenkins", "tok-123", {
        baseUrl: "https://jenkins.example.com",
        username: "ci-readonly",
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("ci-readonly");
      expect(result.details).toMatchObject({ username: "ci-readonly", jobCount: 2 });
    });

    it("returns a clear failure on 401", async () => {
      mockFetchWith([
        {
          match: (u) => u === "https://jenkins.example.com/api/json",
          status: 401,
          body: {},
        },
      ]);
      const result = await verifyConnector("cicd", "jenkins", "wrong", {
        baseUrl: "https://jenkins.example.com",
        username: "ci-readonly",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/auth failed/i);
      expect(result.message).toMatch(/401/);
    });

    it("rejects an SSRF-blocked private base URL before any fetch", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await verifyConnector("cicd", "jenkins", "tok", {
        baseUrl: "http://10.0.0.1",
        username: "ci",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Private IPv4|unsafe URL/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("requires baseUrl, username, and token before issuing a request", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect(
        (await verifyConnector("cicd", "jenkins", "tok", { username: "ci" })).ok,
      ).toBe(false);
      expect(
        (await verifyConnector("cicd", "jenkins", "tok", { baseUrl: "https://j.example.com" })).ok,
      ).toBe(false);
      expect(
        (await verifyConnector("cicd", "jenkins", "", {
          baseUrl: "https://j.example.com",
          username: "ci",
        })).ok,
      ).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("runJenkins", () => {
    it("computes deploy frequency, change failure rate, and build duration", async () => {
      // 9 successful builds + 3 failed (FAILURE) + 1 unstable = 13 total in
      // window. Older build (40 days ago) is intentionally outside the
      // 30-day lookback and must be excluded from totals.
      const now = FIXED_NOW.getTime();
      const inWindow = now - 5 * 86_400_000;
      const stale = now - 40 * 86_400_000;
      const successBuilds = Array.from({ length: 9 }, (_, i) => ({
        number: 100 + i,
        result: "SUCCESS",
        timestamp: inWindow - i * 1_000,
        duration: 10 * 60_000, // 10 minutes
      }));
      const failBuilds = Array.from({ length: 3 }, (_, i) => ({
        number: 200 + i,
        result: "FAILURE",
        timestamp: inWindow - i * 1_000,
        duration: 8 * 60_000,
      }));
      const unstableBuild = {
        number: 300,
        result: "UNSTABLE",
        timestamp: inWindow,
        duration: 12 * 60_000,
      };
      const stillRunning = {
        number: 400,
        result: null,
        timestamp: inWindow,
        duration: 0,
      };
      const oldBuild = {
        number: 999,
        result: "SUCCESS",
        timestamp: stale,
        duration: 5 * 60_000,
      };

      mockFetchWith([
        {
          match: (u) =>
            u.startsWith("https://jenkins.example.com/api/json?tree=jobs"),
          body: {
            jobs: [
              {
                _class: "com.cloudbees.hudson.plugins.folder.Folder",
                name: "platform",
              },
              {
                _class: "hudson.model.FreeStyleProject",
                name: "deploy-prod",
                builds: [
                  ...successBuilds,
                  ...failBuilds,
                  unstableBuild,
                  stillRunning,
                  oldBuild,
                ],
              },
            ],
          },
        },
        {
          match: (u) =>
            u.startsWith(
              "https://jenkins.example.com/job/platform/api/json?tree=jobs",
            ),
          body: {
            jobs: [
              {
                _class: "hudson.model.FreeStyleProject",
                name: "deploy-staging",
                builds: [],
              },
            ],
          },
        },
      ]);

      const out = await runConnector("cicd", "jenkins", "tok", {
        baseUrl: "https://jenkins.example.com",
        username: "ci-readonly",
      });

      // 13 builds in window = 9 success + 3 fail + 1 unstable.
      // CFR per task spec: (FAILURE + UNSTABLE) / total = 4/13 ≈ 0.308.
      expect(out.summary.builds30d).toBe(13);
      expect(out.summary.buildsSucceeded30d).toBe(9);
      expect(out.summary.buildsFailed30d).toBe(4);
      expect(out.summary.deploysPerDay).toBeCloseTo(9 / 30, 5);
      expect(out.summary.changeFailureRate).toBeCloseTo(4 / 13, 2);
      expect(out.summary.jobCount).toBe(2);
      expect(out.summary.buildDurationMinutesAvg).toBeGreaterThan(0);
      // Lead-time signal pinned to build duration in hours for Jenkins.
      expect(out.summary.leadTimeHoursAvg).toBeCloseTo(
        (out.summary.buildDurationMinutesAvg as number) / 60,
        2,
      );

      // Evidence dimensions must mirror the other CI/CD providers so scoring
      // can read across them — process for deploy/duration, measurement for CFR.
      const dims = out.evidence.map((e) => `${e.dimension}:${e.signalType}`);
      expect(dims).toContain("process:strength"); // "actively in use" sentinel
      expect(out.evidence.some((e) => /Deployment frequency \(Jenkins\)/.test(e.text))).toBe(true);
      expect(out.evidence.some((e) => /Change failure rate \(Jenkins\)/.test(e.text))).toBe(true);
      expect(out.evidence.some((e) => /Build duration \(Jenkins\)/.test(e.text))).toBe(true);
    });

    it("surfaces a 'no builds' gap when nothing falls in the lookback window", async () => {
      mockFetchWith([
        {
          match: (u) =>
            u.startsWith("https://jenkins.example.com/api/json?tree=jobs"),
          body: {
            jobs: [
              {
                _class: "hudson.model.FreeStyleProject",
                name: "idle",
                builds: [],
              },
            ],
          },
        },
      ]);
      const out = await runConnector("cicd", "jenkins", "tok", {
        baseUrl: "https://jenkins.example.com",
        username: "ci-readonly",
      });
      expect(out.summary.builds30d).toBe(0);
      expect(out.summary.deploysPerDay).toBeUndefined();
      expect(
        out.evidence.some((e) => /No Jenkins builds found/.test(e.text)),
      ).toBe(true);
    });

    it("throws on a 401 during the job walk so the run is marked failed in history", async () => {
      mockFetchWith([
        {
          match: (u) =>
            u.startsWith("https://jenkins.example.com/api/json?tree=jobs"),
          status: 401,
          body: { message: "Invalid password/token for user: ci-readonly" },
        },
      ]);
      await expect(
        runConnector("cicd", "jenkins", "revoked", {
          baseUrl: "https://jenkins.example.com",
          username: "ci-readonly",
        }),
      ).rejects.toThrow(/Jenkins 401/);
    });

    it("honors the optional jobFilter regex", async () => {
      const t = FIXED_NOW.getTime() - 2 * 86_400_000;
      mockFetchWith([
        {
          match: (u) =>
            u.startsWith("https://jenkins.example.com/api/json?tree=jobs"),
          body: {
            jobs: [
              {
                _class: "hudson.model.FreeStyleProject",
                name: "prod-deploy",
                builds: [
                  { number: 1, result: "SUCCESS", timestamp: t, duration: 60_000 },
                ],
              },
              {
                _class: "hudson.model.FreeStyleProject",
                name: "scratch-job",
                builds: [
                  { number: 1, result: "FAILURE", timestamp: t, duration: 60_000 },
                ],
              },
            ],
          },
        },
      ]);
      const out = await runConnector("cicd", "jenkins", "tok", {
        baseUrl: "https://jenkins.example.com",
        username: "ci-readonly",
        jobFilter: "^prod-",
      });
      // Only prod-deploy contributes — scratch-job is filtered out, so CFR
      // must NOT include the FAILURE.
      expect(out.summary.jobCount).toBe(1);
      expect(out.summary.builds30d).toBe(1);
      expect(out.summary.buildsFailed30d).toBe(0);
    });
  });
});

// ---- CI/CD verify conformance across providers ------------------------
// Recorded happy-path verify responses for every CI/CD sub-provider so a new
// provider can't ship without proving it returns ok=true on the canonical
// authenticated request shape.

interface VerifyCase {
  provider: string;
  config: Record<string, unknown>;
  responses: RecordedResponse[];
}

const verifyCases: VerifyCase[] = [
  {
    provider: "github_actions",
    config: { org: "acme" },
    responses: [
      {
        match: (u) => u === "https://api.github.com/user",
        body: { login: "ci-bot" },
      },
      {
        match: (u) => u === "https://api.github.com/orgs/acme",
        body: { login: "acme" },
      },
    ],
  },
  {
    provider: "circleci",
    config: {},
    responses: [
      {
        match: (u) => u === "https://circleci.com/api/v2/me",
        body: { id: "u-1", login: "ci" },
      },
    ],
  },
  {
    provider: "gitlab_ci",
    config: { baseUrl: "https://gitlab.com", group: "engineering" },
    responses: [
      {
        match: (u) => u === "https://gitlab.com/api/v4/user",
        body: { username: "ci-bot" },
      },
      {
        match: (u) => u === "https://gitlab.com/api/v4/groups/engineering",
        body: { id: 1, full_path: "engineering" },
      },
    ],
  },
  {
    provider: "jenkins",
    config: { baseUrl: "https://jenkins.example.com", username: "ci-readonly" },
    responses: [
      {
        match: (u) => u === "https://jenkins.example.com/api/json",
        body: { nodeName: "main", jobs: [] },
      },
    ],
  },
];

describe.each(verifyCases)(
  "CI/CD verify harness — $provider",
  ({ provider, config, responses }) => {
    it("returns ok=true on the canonical authenticated response", async () => {
      mockFetchWith(responses);
      const out = await verifyConnector("cicd", provider, "tok-xyz", config);
      expect(out.ok).toBe(true);
    });
  },
);
