/**
 * Tests covering the security-critical guarantees of /api/portfolio*:
 *   - Membership scoping (a non-member cannot see another engagement's data
 *     via the portfolio rollup or heatmap endpoints).
 *   - Anonymity floor (heatmap suppresses dimensions with < 5 contributors).
 *   - Admin gating + per-cell suppression on the benchmark CSV.
 *   - CSV escaping + spreadsheet formula-injection neutralisation.
 *
 * The pure helpers (`escapeCsvCell`, `computeHeatmapCells`, `buildBenchmarkCsv`)
 * are tested directly without touching express or the DB. The route-level
 * guarantees (membership scoping, admin 403) are tested with supertest
 * against the real router, with `@workspace/db` mocked to a tiny in-memory
 * store and `req.authedUser` injected by a thin test middleware (so the
 * real `requireAuth` short-circuits without hitting Clerk).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------- Mock @workspace/db ----------------------------------------------
// Drizzle queries in portfolio.ts look like
//   db.select([cols]).from(table).where(<op>).orderBy(<op>).limit(n)
// where <op> is built from drizzle's `eq`/`or`/`and`/`inArray`/`gte`/`lte`.
// We replace those operators with tagged plain objects (see drizzle-orm mock
// below) so the fake db can interpret the where clause as a JS predicate.
//
// `vi.hoisted` is required because `vi.mock` factories are hoisted above all
// other top-level statements. Anything they reference must be hoisted too.
const mocks = vi.hoisted(() => {
  const fixtures: Record<string, Record<string, unknown>[]> = {};

  function makeTable(key: string) {
    return new Proxy(
      { __tableKey: key },
      {
        get(_target, prop) {
          if (prop === "__tableKey") return key;
          return { __col: true, table: key, name: String(prop) };
        },
      },
    );
  }

  function evalWhere(row: Record<string, unknown>, w: any): boolean {
    if (!w) return true;
    switch (w.__op) {
      case "eq":
        return row[w.col.name] === w.val;
      case "or":
        return w.args.some((a: any) => evalWhere(row, a));
      case "and":
        return w.args.every((a: any) => evalWhere(row, a));
      case "inArray":
        return w.vals.includes(row[w.col.name]);
      case "gte":
        return (row[w.col.name] as any) >= w.val;
      case "lte":
        return (row[w.col.name] as any) <= w.val;
      case "isNull":
        return row[w.col.name] == null;
      default:
        return true;
    }
  }

  function projectRows(
    rows: Record<string, unknown>[],
    projection: Record<string, any> | undefined,
  ): Record<string, unknown>[] {
    if (!projection) return rows;
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(projection)) {
        if (v && (v as any).__col) out[k] = r[(v as any).name];
        else out[k] = v;
      }
      return out;
    });
  }

  function makeQueryBuilder(
    tableKey: string,
    projection?: Record<string, any>,
  ) {
    let whereClause: any = null;
    let orderClause: any = null;
    let limitN: number | null = null;

    const exec = async (): Promise<Record<string, unknown>[]> => {
      let result = (fixtures[tableKey] ?? []).filter((r) =>
        evalWhere(r, whereClause),
      );
      if (orderClause && orderClause.__op === "desc") {
        const colName = orderClause.col.name;
        result = result.slice().sort((a, b) => {
          const av = a[colName] as any;
          const bv = b[colName] as any;
          if (av < bv) return 1;
          if (av > bv) return -1;
          return 0;
        });
      }
      if (limitN != null) result = result.slice(0, limitN);
      return projectRows(result, projection);
    };

    const builder: any = {
      where(w: any) {
        whereClause = w;
        return builder;
      },
      orderBy(o: any) {
        orderClause = o;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return exec();
      },
      leftJoin() {
        return builder;
      },
      then(resolve: any, reject: any) {
        return exec().then(resolve, reject);
      },
      catch(reject: any) {
        return exec().catch(reject);
      },
      finally(cb: any) {
        return exec().finally(cb);
      },
    };
    return builder;
  }

  const tables = {
    usersTable: makeTable("users"),
    engagementsTable: makeTable("engagements"),
    engagementMembersTable: makeTable("engagement_members"),
    scoringTable: makeTable("scoring"),
    surveyInvitesTable: makeTable("survey_invites"),
    connectorsTable: makeTable("connectors"),
    deliverableVersionsTable: makeTable("deliverable_versions"),
    activityEventsTable: makeTable("activity_events"),
  };

  return {
    fixtures,
    tables,
    makeQueryBuilder,
    setFixture(key: string, rows: Record<string, unknown>[]) {
      fixtures[key] = rows;
    },
    resetFixtures() {
      for (const k of Object.keys(fixtures)) delete fixtures[k];
    },
  };
});

const setFixture = mocks.setFixture;
const resetFixtures = mocks.resetFixtures;

vi.mock("@workspace/db", () => ({
  db: {
    select(projection?: Record<string, any>) {
      return {
        from(table: any) {
          const key = (table && table.__tableKey) || "unknown";
          return mocks.makeQueryBuilder(key, projection);
        },
      };
    },
    insert() {
      // The benchmark route writes an audit event on success — accept and
      // discard so the route still completes.
      return {
        values: () => Promise.resolve(undefined),
      };
    },
    update() {
      return {
        set: () => ({ where: () => Promise.resolve(undefined) }),
      };
    },
  },
  ...mocks.tables,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __op: "eq", col, val }),
  or: (...args: any[]) => ({ __op: "or", args }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (col: any, vals: any[]) => ({ __op: "inArray", col, vals }),
  gte: (col: any, val: any) => ({ __op: "gte", col, val }),
  lte: (col: any, val: any) => ({ __op: "lte", col, val }),
  desc: (col: any) => ({ __op: "desc", col }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  // sql is referenced as a value by portfolio.ts but never invoked at
  // runtime here; provide a callable stub to satisfy any tag-template use.
  sql: Object.assign(() => ({ __op: "sql" }), { raw: () => ({ __op: "sql" }) }),
}));

// Clerk middleware is wired in app.ts but the portfolio test app below does
// not mount it; we only need to ensure portfolio.ts doesn't pull anything
// network-bound at import time.
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null }),
  clerkClient: { users: { getUser: async () => ({}) } },
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// ---------- Now we can import the route + helpers ---------------------------
import express from "express";
import request from "supertest";
import portfolioRouter from "../src/routes/portfolio";
import {
  ANONYMITY_FLOOR,
  buildBenchmarkCsv,
  computeHeatmapCells,
  escapeCsvCell,
} from "../src/routes/portfolio";

// Build a fresh app per test that injects an `authedUser` (bypassing the
// real `requireAuth`, which short-circuits when `req.authedUser` is set).
function appAs(user: { id: string; email: string }, isDbAdmin = false) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authedUser = {
      id: user.id,
      clerkUserId: `clerk_${user.id}`,
      email: user.email,
      name: user.email,
      avatarUrl: null,
    };
    next();
  });
  // The benchmark route reads usersTable.role for the caller; seed it.
  setFixture("users", [
    { id: user.id, email: user.email, role: isDbAdmin ? "admin" : "assessor" },
  ]);
  app.use("/api", portfolioRouter);
  return app;
}

beforeEach(() => {
  resetFixtures();
  delete process.env.PULSE_ADMIN_EMAILS;
});

// ---------- Pure helper tests ----------------------------------------------

describe("escapeCsvCell — formula injection guard", () => {
  it.each([
    ["=cmd|'/c calc'!A1", "\"'=cmd|'/c calc'!A1\""],
    ["+1+1", "\"'+1+1\""],
    ["-2+3", "\"'-2+3\""],
    ["@SUM(A1)", "\"'@SUM(A1)\""],
    ["\tdanger", '"\'\tdanger"'],
    ["\rdanger", '"\'\rdanger"'],
  ])("neutralises leading %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it("doubles internal quotes (RFC 4180)", () => {
    expect(escapeCsvCell('She said "hi"')).toBe('"She said ""hi"""');
  });

  it("does not prefix safe values", () => {
    expect(escapeCsvCell("Healthcare")).toBe('"Healthcare"');
    expect(escapeCsvCell(42)).toBe('"42"');
  });

  it("renders null/undefined as empty cell", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });
});

describe("computeHeatmapCells — anonymity floor", () => {
  function scoringFor(n: number, dim = "tooling") {
    return Array.from({ length: n }, () => ({
      byDimension: [{ dimension: dim, score: 3, stage: 2 }],
    }));
  }

  it("suppresses dimensions with fewer than ANONYMITY_FLOOR contributors", () => {
    const cells = computeHeatmapCells(scoringFor(ANONYMITY_FLOOR - 1));
    const tooling = cells.find((c) => c.dimension === "tooling")!;
    expect(tooling.suppressed).toBe(true);
    expect(tooling.meanScore).toBeNull();
    expect(tooling.meanStage).toBeNull();
    expect(tooling.count).toBe(ANONYMITY_FLOOR - 1);
  });

  it("emits the mean once the floor is reached", () => {
    const cells = computeHeatmapCells(scoringFor(ANONYMITY_FLOOR));
    const tooling = cells.find((c) => c.dimension === "tooling")!;
    expect(tooling.suppressed).toBe(false);
    expect(tooling.meanScore).toBe(3);
    expect(tooling.meanStage).toBe(2);
    expect(tooling.count).toBe(ANONYMITY_FLOOR);
  });

  it("suppresses dimensions independently (one above floor, one below)", () => {
    const scorings = [
      ...scoringFor(ANONYMITY_FLOOR, "tooling"),
      ...scoringFor(2, "culture"),
    ];
    const cells = computeHeatmapCells(scorings);
    expect(cells.find((c) => c.dimension === "tooling")!.suppressed).toBe(false);
    expect(cells.find((c) => c.dimension === "culture")!.suppressed).toBe(true);
    expect(cells.find((c) => c.dimension === "culture")!.meanScore).toBeNull();
  });
});

describe("buildBenchmarkCsv — per-cell suppression + escaping", () => {
  it("emits SUPPRESSED for cells below the floor and a numeric mean above it", () => {
    const engs = [
      ...Array.from({ length: ANONYMITY_FLOOR }, (_, i) => ({
        id: `e_big_${i}`,
        industry: "Healthcare",
        teamCount: 3, // small band
      })),
      // One single engagement in a different bucket — must be suppressed.
      { id: "e_lonely", industry: "Finance", teamCount: 3 },
    ];
    const scorings = [
      ...Array.from({ length: ANONYMITY_FLOOR }, (_, i) => ({
        engagementId: `e_big_${i}`,
        byDimension: [{ dimension: "tooling", score: 4, stage: 3 }],
      })),
      {
        engagementId: "e_lonely",
        byDimension: [{ dimension: "tooling", score: 1, stage: 1 }],
      },
    ];
    const { csv, emittedCells, suppressedCells } = buildBenchmarkCsv(
      engs,
      scorings,
    );
    expect(emittedCells).toBe(1);
    expect(suppressedCells).toBe(1);
    // Healthcare/small/tooling row has the numeric mean.
    expect(csv).toMatch(
      /"Healthcare","small","tooling","5","4\.000","3\.000"/,
    );
    // Finance/small/tooling row has SUPPRESSED in the numeric columns.
    expect(csv).toMatch(
      /"Finance","small","tooling","1","SUPPRESSED","SUPPRESSED"/,
    );
  });

  it("escapes quotes and neutralises formula-injection in industry labels", () => {
    // NB: only non-whitespace formula-trigger chars are exercised here
    // because the benchmark route trims the industry string before bucketing
    // (so leading `\t` / `\r` would be stripped). Direct tab/CR coverage
    // for `escapeCsvCell` lives in its own describe block above.
    // Also: avoid `|` in the input — `buildBenchmarkCsv` uses `|` as the
    // bucket-key delimiter, so it isn't a safe character in test inputs.
    const engs = [
      { id: "e1", industry: '=cmd("/c calc"!A1)', teamCount: 3 },
      { id: "e2", industry: "+evil", teamCount: 3 },
      { id: "e3", industry: "-evil", teamCount: 3 },
      { id: "e4", industry: "@evil", teamCount: 3 },
    ];
    const scorings = engs.map((e) => ({
      engagementId: e.id,
      byDimension: [{ dimension: "tooling", score: 1, stage: 1 }],
    }));
    const { csv } = buildBenchmarkCsv(engs, scorings);
    // Each formula-prefixed industry is wrapped with `'` and quoted; the
    // inner double-quotes in the first row are doubled per RFC 4180.
    expect(csv).toContain('"\'=cmd(""/c calc""!A1)"');
    expect(csv).toContain('"\'+evil"');
    expect(csv).toContain('"\'-evil"');
    expect(csv).toContain('"\'@evil"');
  });

  it("re-applies the formula guard after trim() strips a leading tab/CR", () => {
    // The route trims industry before bucketing, so a literal leading tab
    // or carriage return is removed. This test pins down the contract:
    // whatever survives the trim still goes through `escapeCsvCell`, so a
    // value like "\t=cmd" (trimmed to "=cmd") is still neutralised.
    const engs = [
      { id: "t1", industry: "\t=cmd", teamCount: 3 },
      { id: "t2", industry: "\r+evil", teamCount: 3 },
    ];
    const scorings = engs.map((e) => ({
      engagementId: e.id,
      byDimension: [{ dimension: "tooling", score: 1, stage: 1 }],
    }));
    const { csv } = buildBenchmarkCsv(engs, scorings);
    expect(csv).toContain('"\'=cmd"');
    expect(csv).toContain('"\'+evil"');
    // And critically: no raw tab/CR survives in the output (which would let
    // a spreadsheet evaluate the leading char before our guard runs).
    expect(csv).not.toMatch(/[\t\r]=cmd/);
    expect(csv).not.toMatch(/[\t\r]\+evil/);
  });
});

// ---------- Route-level integration tests ----------------------------------

const userA = { id: "user_a", email: "alice@example.com" };
const userB = { id: "user_b", email: "bob@example.com" };

function seedTwoEngagementsOwnedSeparately() {
  setFixture("engagements", [
    {
      id: "eng_a",
      clientName: "AlphaCo",
      sponsor: "A",
      industry: "Healthcare",
      teamCount: 3,
      status: "active",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-02"),
      targetDeliveryDate: null,
    },
    {
      id: "eng_b",
      clientName: "BetaCo",
      sponsor: "B",
      industry: "Finance",
      teamCount: 8,
      status: "active",
      createdAt: new Date("2025-02-01"),
      updatedAt: new Date("2025-02-02"),
      targetDeliveryDate: null,
    },
  ]);
  setFixture("engagement_members", [
    { id: "m1", engagementId: "eng_a", userId: userA.id, email: userA.email },
    { id: "m2", engagementId: "eng_b", userId: userB.id, email: userB.email },
  ]);
  // Empty support tables so handlers don't NPE.
  setFixture("scoring", []);
  setFixture("survey_invites", []);
  setFixture("connectors", []);
  setFixture("deliverable_versions", []);
  setFixture("activity_events", []);
}

describe("GET /api/portfolio — membership scoping", () => {
  it("only returns engagements the caller is a member of", async () => {
    seedTwoEngagementsOwnedSeparately();
    const app = appAs(userB);
    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    const ids = (res.body.engagements as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual(["eng_b"]);
    expect(ids).not.toContain("eng_a");
  });

  it("returns an empty portfolio for a user with no memberships", async () => {
    seedTwoEngagementsOwnedSeparately();
    const app = appAs({ id: "user_orphan", email: "orphan@example.com" });
    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.engagements).toEqual([]);
  });
});

describe("GET /api/portfolio/heatmap — membership scoping + suppression", () => {
  it("suppresses every dimension when the caller's portfolio is below the floor", async () => {
    seedTwoEngagementsOwnedSeparately();
    // Even with scoring rows present for both engagements, user B can only
    // see eng_b's contribution (1 sample), so all dimensions stay suppressed.
    setFixture("scoring", [
      {
        engagementId: "eng_a",
        byDimension: Array.from({ length: 6 }).map((_, i) => ({
          dimension: ["tooling", "measurement", "process", "people", "governance", "culture"][i],
          score: 5,
          stage: 4,
        })),
      },
      {
        engagementId: "eng_b",
        byDimension: [{ dimension: "tooling", score: 2, stage: 1 }],
      },
    ]);
    const app = appAs(userB);
    const res = await request(app).get("/api/portfolio/heatmap");
    expect(res.status).toBe(200);
    expect(res.body.engagementCount).toBe(1);
    for (const cell of res.body.cells as Array<{ suppressed: boolean; meanScore: number | null }>) {
      expect(cell.suppressed).toBe(true);
      expect(cell.meanScore).toBeNull();
    }
  });

  it("emits real means when the floor is met (and only counts the caller's engagements)", async () => {
    // user A is the sole member of all five engagements. user B has none.
    setFixture("engagement_members", [
      { id: "ma1", engagementId: "e1", userId: userA.id, email: userA.email },
      { id: "ma2", engagementId: "e2", userId: userA.id, email: userA.email },
      { id: "ma3", engagementId: "e3", userId: userA.id, email: userA.email },
      { id: "ma4", engagementId: "e4", userId: userA.id, email: userA.email },
      { id: "ma5", engagementId: "e5", userId: userA.id, email: userA.email },
      { id: "mb1", engagementId: "e_other", userId: userB.id, email: userB.email },
    ]);
    const baseEng = (id: string, industry: string, teamCount: number) => ({
      id,
      clientName: id,
      sponsor: "x",
      industry,
      teamCount,
      status: "active",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
      targetDeliveryDate: null,
    });
    setFixture("engagements", [
      baseEng("e1", "Healthcare", 3),
      baseEng("e2", "Healthcare", 3),
      baseEng("e3", "Healthcare", 3),
      baseEng("e4", "Healthcare", 3),
      baseEng("e5", "Healthcare", 3),
      baseEng("e_other", "Finance", 3),
    ]);
    setFixture(
      "scoring",
      ["e1", "e2", "e3", "e4", "e5", "e_other"].map((eid) => ({
        engagementId: eid,
        byDimension: [{ dimension: "tooling", score: 3, stage: 2 }],
      })),
    );
    setFixture("survey_invites", []);
    setFixture("connectors", []);
    setFixture("deliverable_versions", []);
    setFixture("activity_events", []);

    const app = appAs(userA);
    const res = await request(app).get("/api/portfolio/heatmap");
    expect(res.status).toBe(200);
    expect(res.body.engagementCount).toBe(5);
    const tooling = (res.body.cells as Array<any>).find(
      (c) => c.dimension === "tooling",
    )!;
    expect(tooling.suppressed).toBe(false);
    expect(tooling.count).toBe(5);
    expect(tooling.meanScore).toBe(3);
  });
});

describe("GET /api/portfolio/benchmark.csv — admin gating + suppression", () => {
  it("returns 403 when the caller is neither a DB admin nor in PULSE_ADMIN_EMAILS", async () => {
    seedTwoEngagementsOwnedSeparately();
    const app = appAs(userB, /*isDbAdmin*/ false);
    const res = await request(app).get("/api/portfolio/benchmark.csv");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("allows users in PULSE_ADMIN_EMAILS and emits SUPPRESSED for low-count cells", async () => {
    process.env.PULSE_ADMIN_EMAILS = userB.email;
    // 5 engagements in (Healthcare, small) so the bucket clears the floor.
    // 1 engagement in (Finance, small) so the bucket must be suppressed.
    const engs = [
      ...Array.from({ length: ANONYMITY_FLOOR }, (_, i) => ({
        id: `eh_${i}`,
        clientName: `H${i}`,
        sponsor: "x",
        industry: "Healthcare",
        teamCount: 3,
        status: "active",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        targetDeliveryDate: null,
      })),
      {
        id: "ef_1",
        clientName: "F1",
        sponsor: "x",
        industry: "Finance",
        teamCount: 3,
        status: "active",
        createdAt: new Date("2025-01-02"),
        updatedAt: new Date("2025-01-02"),
        targetDeliveryDate: null,
      },
    ];
    setFixture("engagements", engs);
    setFixture(
      "scoring",
      engs.map((e) => ({
        engagementId: e.id,
        byDimension: [{ dimension: "tooling", score: 4, stage: 3 }],
      })),
    );
    setFixture("engagement_members", []);

    const app = appAs(userB, /*isDbAdmin*/ false);
    const res = await request(app).get("/api/portfolio/benchmark.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const body = res.text;
    expect(body).toMatch(
      /"Healthcare","small","tooling","5","4\.000","3\.000"/,
    );
    expect(body).toMatch(
      /"Finance","small","tooling","1","SUPPRESSED","SUPPRESSED"/,
    );
  });

  it("allows users with role=admin in the users table", async () => {
    setFixture("engagements", []);
    setFixture("scoring", []);
    const app = appAs(userB, /*isDbAdmin*/ true);
    const res = await request(app).get("/api/portfolio/benchmark.csv");
    expect(res.status).toBe(200);
  });
});
