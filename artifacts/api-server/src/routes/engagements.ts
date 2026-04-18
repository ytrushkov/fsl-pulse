import { Router, type IRouter } from "express";
import { eq, desc, and, or, inArray } from "drizzle-orm";
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
  engagementMembersTable,
  usersTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { DEFAULT_SURVEY_QUESTIONS } from "../lib/survey-template";
import {
  requireAuth,
  requireEngagementMember,
  requireEngagementOwner,
} from "../middlewares/auth";

const router: IRouter = Router();

router.get("/me", async (req, res): Promise<void> => {
  const u = req.authedUser!;
  // Look up role + createdAt from DB so the response matches the OpenAPI contract.
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, u.id))
    .limit(1);
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    role: (row?.role ?? "assessor") as "admin" | "assessor" | "viewer",
    createdAt: row?.createdAt?.toISOString() ?? new Date().toISOString(),
  });
});

router.get("/engagements", async (req, res): Promise<void> => {
  const user = req.authedUser!;
  const memberRows = await db
    .select({ engagementId: engagementMembersTable.engagementId })
    .from(engagementMembersTable)
    .where(
      or(
        eq(engagementMembersTable.userId, user.id),
        eq(engagementMembersTable.email, user.email),
      ),
    );
  const ids = memberRows.map((m) => m.engagementId);
  if (ids.length === 0) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(engagementsTable)
    .where(inArray(engagementsTable.id, ids))
    .orderBy(desc(engagementsTable.createdAt));
  res.json(rows);
});

router.post("/engagements", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.clientName || !b.sponsor || typeof b.teamCount !== "number") {
    res.status(400).json({ error: "clientName, sponsor, teamCount required" });
    return;
  }
  const user = req.authedUser!;
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
      targetDeliveryDate: b.targetDeliveryDate
        ? new Date(b.targetDeliveryDate)
        : null,
      status: "draft",
    })
    .returning();

  // Creator becomes the owner.
  await db.insert(engagementMembersTable).values({
    engagementId: eng.id,
    userId: user.id,
    email: user.email,
    role: "owner",
  });

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
    actorUserId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    kind: "engagement_created",
    message: `Engagement created for ${eng.clientName}`,
  });
  res.status(201).json(eng);
});

router.get(
  "/engagements/:id",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [eng] = await db
      .select()
      .from(engagementsTable)
      .where(eq(engagementsTable.id, id));
    if (!eng) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(eng);
  },
);

router.patch(
  "/engagements/:id",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
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
      set.targetDeliveryDate = b.targetDeliveryDate
        ? new Date(b.targetDeliveryDate)
        : null;
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
  },
);

router.get(
  "/engagements/:id/dashboard",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [eng] = await db
      .select()
      .from(engagementsTable)
      .where(eq(engagementsTable.id, id));
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
      (c) =>
        c.status === "configured" ||
        c.status === "collected" ||
        c.status === "collecting",
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
  },
);

router.get(
  "/engagements/:id/activity",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = await db
      .select({
        id: activityEventsTable.id,
        kind: activityEventsTable.kind,
        message: activityEventsTable.message,
        createdAt: activityEventsTable.createdAt,
        actorUserId: activityEventsTable.actorUserId,
        actorName: activityEventsTable.actorName,
        actorEmail: activityEventsTable.actorEmail,
        actorAvatarUrl: usersTable.avatarUrl,
      })
      .from(activityEventsTable)
      .leftJoin(usersTable, eq(usersTable.id, activityEventsTable.actorUserId))
      .where(eq(activityEventsTable.engagementId, id))
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(50);
    res.json(rows);
  },
);

router.get(
  "/engagements/:id/members",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = await db
      .select({
        id: engagementMembersTable.id,
        engagementId: engagementMembersTable.engagementId,
        email: engagementMembersTable.email,
        role: engagementMembersTable.role,
        userId: engagementMembersTable.userId,
        invitedBy: engagementMembersTable.invitedBy,
        invitedAt: engagementMembersTable.invitedAt,
        name: usersTable.name,
        avatarUrl: usersTable.avatarUrl,
      })
      .from(engagementMembersTable)
      .leftJoin(usersTable, eq(engagementMembersTable.userId, usersTable.id))
      .where(eq(engagementMembersTable.engagementId, id))
      .orderBy(desc(engagementMembersTable.invitedAt));
    res.json(
      rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        userId: r.userId,
        email: r.email,
        name: r.name,
        avatarUrl: r.avatarUrl,
        role: r.role,
        status: r.userId ? "active" : "pending",
        invitedBy: r.invitedBy,
        createdAt: r.invitedAt.toISOString(),
      })),
    );
  },
);

router.post(
  "/engagements/:id/members",
  requireAuth,
  requireEngagementOwner,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const email = (req.body?.email ?? "").toString().trim().toLowerCase();
    const role = (req.body?.role ?? "assessor").toString();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }
    if (!["owner", "assessor", "viewer"].includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
    // Dedupe — already a member?
    const [existing] = await db
      .select()
      .from(engagementMembersTable)
      .where(
        and(
          eq(engagementMembersTable.engagementId, id),
          eq(engagementMembersTable.email, email),
        ),
      );
    if (existing) {
      res.status(409).json({ error: "Email is already a member" });
      return;
    }
    // Link to user record if one exists
    const [maybeUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    const actor = req.authedUser!;
    const [member] = await db
      .insert(engagementMembersTable)
      .values({
        engagementId: id,
        userId: maybeUser?.id ?? null,
        email,
        role: role as "owner" | "assessor" | "viewer",
        invitedBy: actor.id,
      })
      .returning();
    await db.insert(activityEventsTable).values({
      engagementId: id,
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      kind: "member_added",
      message: `Added ${email} as ${role}`,
    });
    res.status(201).json({
      id: member.id,
      engagementId: member.engagementId,
      userId: member.userId,
      email: member.email,
      name: maybeUser?.name ?? null,
      avatarUrl: maybeUser?.avatarUrl ?? null,
      role: member.role,
      status: member.userId ? "active" : "pending",
      invitedBy: member.invitedBy,
      createdAt: member.invitedAt.toISOString(),
    });
  },
);

router.delete(
  "/engagements/:id/members/:memberId",
  requireAuth,
  requireEngagementOwner,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const memberId = paramId(req.params.memberId);
    if (!id || !memberId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [target] = await db
      .select()
      .from(engagementMembersTable)
      .where(
        and(
          eq(engagementMembersTable.id, memberId),
          eq(engagementMembersTable.engagementId, id),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.role === "owner") {
      res.status(400).json({ error: "Cannot remove the owner" });
      return;
    }
    await db
      .delete(engagementMembersTable)
      .where(eq(engagementMembersTable.id, memberId));
    const actor = req.authedUser!;
    await db.insert(activityEventsTable).values({
      engagementId: id,
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      kind: "member_removed",
      message: `Removed ${target.email} from the engagement`,
    });
    res.sendStatus(204);
  },
);

export default router;
