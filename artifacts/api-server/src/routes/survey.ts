import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  surveysTable,
  surveyInvitesTable,
  surveyResponsesTable,
  engagementsTable,
  activityEventsTable,
} from "@workspace/db";
import { paramId, newToken } from "../lib/util";
import { DEFAULT_SURVEY_QUESTIONS } from "../lib/survey-template";

const ANONYMITY_FLOOR = 5;

const router: IRouter = Router();

// Single source of truth: serve live PRD template, filtered by enabled optional modules.
// Persisted snapshot is preserved for audit but not authoritative for v1.
function questionsForEngagement(modules: string[] | null | undefined) {
  const enabled = new Set((modules ?? []) as string[]);
  return DEFAULT_SURVEY_QUESTIONS.filter(
    (q) => !q.moduleKey || enabled.has(q.moduleKey),
  );
}

router.get("/engagements/:id/survey", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [s] = await db.select().from(surveysTable).where(eq(surveysTable.engagementId, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const questions = questionsForEngagement(s.modules as string[]);
  res.json({
    engagementId: s.engagementId,
    templateVersion: s.templateVersion,
    modules: s.modules,
    questions,
    nudgeSchedule: s.nudgeSchedule,
  });
});

router.patch("/engagements/:id/survey", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  if (b.modules) set.modules = b.modules;
  if (b.questions) set.questions = b.questions;
  if (b.nudgeSchedule) set.nudgeSchedule = b.nudgeSchedule;
  const [s] = await db
    .update(surveysTable)
    .set(set)
    .where(eq(surveysTable.engagementId, id))
    .returning();
  res.json({
    engagementId: s.engagementId,
    templateVersion: s.templateVersion,
    modules: s.modules,
    questions: s.questions,
    nudgeSchedule: s.nudgeSchedule,
  });
});

router.get("/engagements/:id/survey/invites", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.engagementId, id));
  res.json(rows);
});

router.post("/engagements/:id/survey/invites", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!Array.isArray(b.invites) || b.invites.length === 0) {
    res.status(400).json({ error: "invites array required" });
    return;
  }
  const rows = await db
    .insert(surveyInvitesTable)
    .values(
      b.invites.map((i: { team: string; email?: string }) => ({
        engagementId: id,
        team: i.team,
        emailHash: i.email
          ? createHash("sha256").update(i.email.toLowerCase()).digest("hex")
          : null,
        token: newToken(),
        status: "sent",
      })),
    )
    .returning();
  await db.insert(activityEventsTable).values({
    engagementId: id,
    kind: "invites_sent",
    message: `Created ${rows.length} survey invites`,
  });
  res.status(201).json(rows);
});

router.get("/engagements/:id/survey/responses", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const invites = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.engagementId, id));
  const responses = await db
    .select()
    .from(surveyResponsesTable)
    .where(eq(surveyResponsesTable.engagementId, id));

  const totalSent = invites.length;
  const totalCompleted = invites.filter((i) => i.status === "completed").length;
  const responseRate = totalSent > 0 ? totalCompleted / totalSent : 0;

  // By question distribution
  const qMap = new Map(DEFAULT_SURVEY_QUESTIONS.map((q) => [q.id, q]));
  const distMap = new Map<string, Map<string, number>>();
  const sumMap = new Map<string, { sum: number; n: number }>();
  for (const r of responses) {
    const ans = r.answers as Array<{ questionId: string; value: unknown }>;
    for (const a of ans) {
      if (!distMap.has(a.questionId)) distMap.set(a.questionId, new Map());
      const m = distMap.get(a.questionId)!;
      const key = String(a.value);
      m.set(key, (m.get(key) ?? 0) + 1);
      const num = typeof a.value === "number" ? a.value : Number(a.value);
      if (Number.isFinite(num)) {
        const s = sumMap.get(a.questionId) ?? { sum: 0, n: 0 };
        s.sum += num;
        s.n += 1;
        sumMap.set(a.questionId, s);
      }
    }
  }
  const byQuestion = Array.from(distMap.entries()).map(([qid, m]) => {
    const s = sumMap.get(qid);
    return {
      questionId: qid,
      average: s && s.n > 0 ? s.sum / s.n : null,
      distribution: Array.from(m.entries()).map(([value, count]) => ({ value, count })),
    };
  });

  // By team
  const teamMap = new Map<string, typeof responses>();
  for (const r of responses) {
    if (!teamMap.has(r.team)) teamMap.set(r.team, [] as unknown as typeof responses);
    teamMap.get(r.team)!.push(r);
  }
  const byTeam = Array.from(teamMap.entries()).map(([team, rs]) => {
    const completedCount = rs.length;
    const suppressed = completedCount < ANONYMITY_FLOOR;
    if (suppressed) {
      return { team, completedCount, suppressed: true };
    }
    // dimension averages
    const dimSums: Record<string, { sum: number; n: number }> = {};
    for (const r of rs) {
      const ans = r.answers as Array<{ questionId: string; value: unknown }>;
      for (const a of ans) {
        const q = qMap.get(a.questionId);
        if (!q?.dimension || q.type !== "likert") continue;
        const v = typeof a.value === "number" ? a.value : Number(a.value);
        if (!Number.isFinite(v)) continue;
        const s = dimSums[q.dimension] ?? { sum: 0, n: 0 };
        s.sum += v;
        s.n += 1;
        dimSums[q.dimension] = s;
      }
    }
    const dimensionAverages: Record<string, number> = {};
    for (const [d, s] of Object.entries(dimSums)) {
      dimensionAverages[d] = Number((s.sum / s.n).toFixed(2));
    }
    return { team, completedCount, suppressed: false, dimensionAverages };
  });

  // Anonymity floor: suppress per-question aggregates when total responses < 5
  const aggregateSuppressed = totalCompleted < ANONYMITY_FLOOR;
  res.json({
    responseRate,
    totalSent,
    totalCompleted,
    aggregateSuppressed,
    byQuestion: aggregateSuppressed ? [] : byQuestion,
    byTeam,
  });
});

router.get("/survey/respond/:token", async (req, res): Promise<void> => {
  const token = paramId(req.params.token);
  if (!token) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const [inv] = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.token, token));
  if (!inv) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  const [eng] = await db
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, inv.engagementId));
  const [survey] = await db
    .select()
    .from(surveysTable)
    .where(eq(surveysTable.engagementId, inv.engagementId));
  if (inv.status !== "completed" && inv.status === "sent") {
    await db
      .update(surveyInvitesTable)
      .set({ status: "opened" })
      .where(eq(surveyInvitesTable.id, inv.id));
  }
  const questions = questionsForEngagement(survey?.modules as string[]);
  res.json({
    engagementClient: eng?.clientName ?? "",
    status: inv.status === "completed" ? "completed" : "open",
    questions,
  });
});

router.post("/survey/respond/:token", async (req, res): Promise<void> => {
  const token = paramId(req.params.token);
  if (!token) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const b = req.body ?? {};
  if (!Array.isArray(b.answers)) {
    res.status(400).json({ error: "answers required" });
    return;
  }
  const [inv] = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.token, token));
  if (!inv) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  if (inv.status === "completed") {
    res.status(409).json({ error: "Already submitted" });
    return;
  }
  await db.insert(surveyResponsesTable).values({
    inviteId: inv.id,
    engagementId: inv.engagementId,
    team: inv.team,
    answers: b.answers,
    demographics: b.demographics ?? {},
  });
  await db
    .update(surveyInvitesTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(surveyInvitesTable.id, inv.id));
  res.sendStatus(204);
});

export default router;
