import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  db,
  engagementsTable,
  surveysTable,
  surveyInvitesTable,
  surveyResponsesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import surveyRouter from "./survey";
import { newToken, hashInviteToken } from "../lib/util";

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id: string }).id = randomUUID();
    next();
  });
  app.use(surveyRouter);
  return app;
}

async function createEngagementAndSurvey() {
  const [eng] = await db
    .insert(engagementsTable)
    .values({
      clientName: `Test Client ${randomUUID().slice(0, 8)}`,
      sponsor: "Sponsor",
      teamCount: 1,
    })
    .returning();
  await db.insert(surveysTable).values({ engagementId: eng!.id });
  return eng!.id;
}

async function createInvite(opts: {
  engagementId: string;
  team?: string;
  role?: string | null;
  status?: string;
  expiresAt?: Date | null;
}): Promise<{ id: string; plain: string }> {
  const plain = newToken();
  const [row] = await db
    .insert(surveyInvitesTable)
    .values({
      engagementId: opts.engagementId,
      team: opts.team ?? "Team A",
      role: opts.role ?? null,
      token: hashInviteToken(plain),
      expiresAt: opts.expiresAt ?? null,
      status: opts.status ?? "sent",
    })
    .returning();
  return { id: row!.id, plain };
}

let app: Express;

beforeAll(() => {
  app = buildTestApp();
});

describe("GET /survey/respond/:token — magic-link states", () => {
  let engagementId: string;

  beforeEach(async () => {
    engagementId = await createEngagementAndSurvey();
  });

  it("returns status=expired with a friendly payload (not 404) when the link has expired", async () => {
    const { plain, id: inviteId } = await createInvite({
      engagementId,
      expiresAt: new Date(Date.now() - 60_000), // 1 min ago
    });

    const res = await request(app).get(`/survey/respond/${plain}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
    expect(Array.isArray(res.body.questions)).toBe(true);
    expect(res.body.savedAnswers).toEqual([]);

    // Invite must NOT have been flipped to "opened" — expired links are
    // frozen so post-expiry visits don't mutate engagement metrics.
    const [after] = await db
      .select()
      .from(surveyInvitesTable)
      .where(eq(surveyInvitesTable.id, inviteId));
    expect(after?.status).toBe("sent");
  });

  it("returns status=open for a non-expired link and flips invite to opened", async () => {
    const { plain, id: inviteId } = await createInvite({
      engagementId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await request(app).get(`/survey/respond/${plain}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    const [after] = await db
      .select()
      .from(surveyInvitesTable)
      .where(eq(surveyInvitesTable.id, inviteId));
    expect(after?.status).toBe("opened");
  });

  it("returns 404 with friendly error for a totally unknown token", async () => {
    const res = await request(app).get(`/survey/respond/${newToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/expired|invalid/i);
  });
});

describe("GET /engagements/:id/survey/responses — anonymity floor", () => {
  it("suppresses team breakdown counts when fewer than 5 respondents", async () => {
    const engagementId = await createEngagementAndSurvey();
    // Create 3 invites + 3 completed responses on the same team.
    for (let i = 0; i < 3; i++) {
      const { id: inviteId } = await createInvite({
        engagementId,
        team: "Small Team",
        role: "Engineer",
        status: "completed",
      });
      await db.insert(surveyResponsesTable).values({
        inviteId,
        engagementId,
        team: "Small Team",
        answers: [{ questionId: "q1", value: 4 }],
      });
    }

    const res = await request(app).get(
      `/engagements/${engagementId}/survey/responses`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalCompleted).toBe(3);
    // Engagement-level aggregate is also suppressed when total < 5.
    expect(res.body.aggregateSuppressed).toBe(true);
    expect(res.body.byQuestion).toEqual([]);

    const team = res.body.byTeam.find(
      (t: { team: string }) => t.team === "Small Team",
    );
    expect(team).toBeDefined();
    expect(team.suppressed).toBe(true);
    expect(team.completedCount).toBeNull();
    // invitedCount is public information (assessor sent the invites).
    expect(team.invitedCount).toBe(3);

    const role = res.body.byRole.find(
      (r: { role: string }) => r.role === "Engineer",
    );
    expect(role).toBeDefined();
    expect(role.suppressed).toBe(true);
    expect(role.completedCount).toBeNull();
  });

  it("exposes exact counts when respondents meet the anonymity floor (>=5)", async () => {
    const engagementId = await createEngagementAndSurvey();
    for (let i = 0; i < 5; i++) {
      const { id: inviteId } = await createInvite({
        engagementId,
        team: "Big Team",
        role: "Manager",
        status: "completed",
      });
      await db.insert(surveyResponsesTable).values({
        inviteId,
        engagementId,
        team: "Big Team",
        answers: [{ questionId: "q1", value: 4 }],
      });
    }

    const res = await request(app).get(
      `/engagements/${engagementId}/survey/responses`,
    );
    expect(res.status).toBe(200);
    expect(res.body.aggregateSuppressed).toBe(false);
    const team = res.body.byTeam.find(
      (t: { team: string }) => t.team === "Big Team",
    );
    expect(team.suppressed).toBe(false);
    expect(team.completedCount).toBe(5);
    const role = res.body.byRole.find(
      (r: { role: string }) => r.role === "Manager",
    );
    expect(role.suppressed).toBe(false);
    expect(role.completedCount).toBe(5);
  });
});
