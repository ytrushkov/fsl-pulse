import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  engagementsTable,
  surveysTable,
  deliverablesTable,
  surveyInvitesTable,
  interviewsTable,
  artifactDocsTable,
  connectorsTable,
  evidenceTable,
  activityEventsTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { DEFAULT_SURVEY_QUESTIONS } from "../lib/survey-template";

const router: IRouter = Router();

router.get("/engagements", async (_req, res): Promise<void> => {
  const rows = await db.select().from(engagementsTable).orderBy(desc(engagementsTable.createdAt));
  res.json(rows);
});

router.post("/engagements", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.clientName || !b.sponsor || typeof b.teamCount !== "number") {
    res.status(400).json({ error: "clientName, sponsor, teamCount required" });
    return;
  }
  const [eng] = await db
    .insert(engagementsTable)
    .values({
      clientName: b.clientName,
      sponsor: b.sponsor,
      teamCount: b.teamCount,
      scope: b.scope ?? "",
      teams: b.teams ?? [],
      modules: b.modules ?? [],
      kickoffDate: b.kickoffDate ? new Date(b.kickoffDate) : null,
      targetDeliveryDate: b.targetDeliveryDate ? new Date(b.targetDeliveryDate) : null,
      status: "draft",
    })
    .returning();

  // Seed default survey + deliverables shell
  await db.insert(surveysTable).values({
    engagementId: eng.id,
    templateVersion: "1.0.0",
    modules: b.modules ?? [],
    questions: DEFAULT_SURVEY_QUESTIONS,
    nudgeSchedule: [3, 7],
  });
  await db.insert(deliverablesTable).values({
    engagementId: eng.id,
    statuses: {
      heatmap: "draft",
      gapAnalysis: "draft",
      actionPlan: "draft",
      entryPoint: "draft",
      npv: "draft",
    },
    heatmap: [],
    gapAnalysis: [],
    actionPlan: [],
    entryPoint: null,
    npv: null,
  });
  await db.insert(activityEventsTable).values({
    engagementId: eng.id,
    kind: "engagement_created",
    message: `Engagement created for ${eng.clientName}`,
  });
  res.status(201).json(eng);
});

router.get("/engagements/:id", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!eng) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(eng);
});

router.patch("/engagements/:id", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  for (const k of [
    "clientName",
    "sponsor",
    "teamCount",
    "scope",
    "teams",
    "modules",
    "status",
  ]) {
    if (k in b) set[k] = b[k];
  }
  if ("kickoffDate" in b)
    set.kickoffDate = b.kickoffDate ? new Date(b.kickoffDate) : null;
  if ("targetDeliveryDate" in b)
    set.targetDeliveryDate = b.targetDeliveryDate ? new Date(b.targetDeliveryDate) : null;
  const [updated] = await db
    .update(engagementsTable)
    .set(set)
    .where(eq(engagementsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

router.get("/engagements/:id/dashboard", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!eng) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const invites = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.engagementId, id));
  const interviews = await db
    .select()
    .from(interviewsTable)
    .where(eq(interviewsTable.engagementId, id));
  const artifacts = await db
    .select()
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.engagementId, id));
  const connectors = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.engagementId, id));
  const evidence = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.engagementId, id));
  const [deliverables] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));

  const totalSent = invites.length;
  const totalCompleted = invites.filter((i) => i.status === "completed").length;
  const responseRate = totalSent > 0 ? totalCompleted / totalSent : 0;
  const interviewsCompleted = interviews.filter(
    (i) => i.status === "tagged" || i.status === "reviewed",
  ).length;
  const connectorsHealthy = connectors.filter(
    (c) => c.status === "configured" || c.status === "collected" || c.status === "collecting",
  ).length;
  const daysToTarget = eng.targetDeliveryDate
    ? Math.ceil((+new Date(eng.targetDeliveryDate) - Date.now()) / 86400000)
    : null;

  res.json({
    engagementId: id,
    surveyResponseRate: responseRate,
    surveySent: totalSent,
    surveyCompleted: totalCompleted,
    interviewsCompleted,
    interviewsTotal: interviews.length,
    artifactCount: artifacts.length,
    connectorsHealthy,
    connectorsTotal: connectors.length,
    daysToTarget,
    evidenceCount: evidence.length,
    deliverableStatuses: deliverables?.statuses ?? {
      heatmap: "draft",
      gapAnalysis: "draft",
      actionPlan: "draft",
      entryPoint: "draft",
      npv: "draft",
    },
  });
});

router.get("/engagements/:id/activity", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(activityEventsTable)
    .where(eq(activityEventsTable.engagementId, id))
    .orderBy(desc(activityEventsTable.createdAt))
    .limit(50);
  res.json(rows);
});

export default router;
