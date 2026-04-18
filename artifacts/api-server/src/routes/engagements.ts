import { Router, type IRouter } from "express";
import { eq, desc, and, or, inArray, gte, lte, sql } from "drizzle-orm";
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
import { recordActivity } from "../lib/audit";
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
  await recordActivity(req, {
    engagementId: eng.id,
    kind: "engagement_created",
    message: `Engagement created for ${eng.clientName}`,
    payload: {
      clientName: eng.clientName,
      sponsor: eng.sponsor,
      teamCount: eng.teamCount,
      modules: eng.modules,
    },
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
    const [previous] = await db
      .select()
      .from(engagementsTable)
      .where(eq(engagementsTable.id, id));
    const [updated] = await db
      .update(engagementsTable)
      .set(set)
      .where(eq(engagementsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Status changes (e.g. discovery -> exported) and member-count changes
    // are the highest-signal edits, so flag a status flip as critical so it
    // shows up prominently in the activity timeline.
    const statusChanged =
      previous && "status" in set && previous.status !== updated.status;
    await recordActivity(req, {
      engagementId: id,
      kind: statusChanged ? "engagement_status_changed" : "engagement_updated",
      severity: statusChanged ? "critical" : "info",
      message: statusChanged
        ? `Engagement status changed: ${previous?.status} → ${updated.status}`
        : `Engagement updated (${Object.keys(set).join(", ") || "no fields"})`,
      payload: {
        fields: Object.keys(set),
        previousStatus: previous?.status,
        newStatus: updated.status,
      },
    });
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

/**
 * Build the WHERE clause for /activity queries shared between the JSON list
 * endpoint and the CSV export. Supported filters:
 *   - kind:     comma-separated list of activity kinds
 *   - actor:    matches actor name OR email (case-insensitive substring)
 *   - severity: "critical" or "info"
 *   - from/to:  ISO timestamps for createdAt range
 */
function buildActivityWhere(engagementId: string, q: Record<string, unknown>) {
  const clauses = [eq(activityEventsTable.engagementId, engagementId)];
  const kindRaw = typeof q.kind === "string" ? q.kind : undefined;
  if (kindRaw) {
    const kinds = kindRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (kinds.length > 0) clauses.push(inArray(activityEventsTable.kind, kinds));
  }
  const sev = typeof q.severity === "string" ? q.severity : undefined;
  if (sev === "critical" || sev === "info") {
    clauses.push(eq(activityEventsTable.severity, sev));
  }
  const actor = typeof q.actor === "string" ? q.actor.trim() : undefined;
  if (actor) {
    const like = `%${actor.toLowerCase()}%`;
    clauses.push(
      or(
        sql`lower(coalesce(${activityEventsTable.actorName}, '')) like ${like}`,
        sql`lower(coalesce(${activityEventsTable.actorEmail}, '')) like ${like}`,
      )!,
    );
  }
  const from = typeof q.from === "string" ? Date.parse(q.from) : NaN;
  if (Number.isFinite(from)) {
    clauses.push(gte(activityEventsTable.createdAt, new Date(from)));
  }
  const to = typeof q.to === "string" ? Date.parse(q.to) : NaN;
  if (Number.isFinite(to)) {
    clauses.push(lte(activityEventsTable.createdAt, new Date(to)));
  }
  return and(...clauses);
}

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
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(500, Math.floor(limitRaw))
      : 50;
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
        severity: activityEventsTable.severity,
        payload: activityEventsTable.payload,
        requestId: activityEventsTable.requestId,
      })
      .from(activityEventsTable)
      .leftJoin(usersTable, eq(usersTable.id, activityEventsTable.actorUserId))
      .where(buildActivityWhere(id, req.query as Record<string, unknown>))
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(limit);
    res.json(rows);
  },
);

/**
 * Admin-only CSV export of the audit log. Same filters as the JSON endpoint.
 * Restricted to global `admin` users so engagement members can't bulk-export
 * everyone else's activity even if they have engagement access.
 */
router.get(
  "/engagements/:id/activity.csv",
  requireAuth,
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const u = req.authedUser!;
    const [me] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, u.id))
      .limit(1);
    if (me?.role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const rows = await db
      .select({
        id: activityEventsTable.id,
        kind: activityEventsTable.kind,
        severity: activityEventsTable.severity,
        message: activityEventsTable.message,
        createdAt: activityEventsTable.createdAt,
        actorName: activityEventsTable.actorName,
        actorEmail: activityEventsTable.actorEmail,
        requestId: activityEventsTable.requestId,
        payload: activityEventsTable.payload,
      })
      .from(activityEventsTable)
      .where(buildActivityWhere(id, req.query as Record<string, unknown>))
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(10_000);
    const header = [
      "id",
      "createdAt",
      "kind",
      "severity",
      "actorName",
      "actorEmail",
      "requestId",
      "message",
      "payload",
    ];
    // RFC4180-ish: wrap every cell in quotes, escape internal quotes by doubling.
    // Also defend against spreadsheet formula injection by prefixing any cell
    // whose value starts with =, +, -, @, tab, or CR with a single quote so
    // Excel/Sheets treat it as text instead of evaluating it as a formula.
    const esc = (v: unknown): string => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.createdAt.toISOString(),
          r.kind,
          r.severity,
          r.actorName ?? "",
          r.actorEmail ?? "",
          r.requestId ?? "",
          r.message,
          JSON.stringify(r.payload ?? {}),
        ]
          .map(esc)
          .join(","),
      );
    }
    // Critical audit: someone (admin) just downloaded the engagement's full
    // activity log as CSV. Capture which filters they used and how many rows
    // they pulled so a compliance reviewer can see exactly what left the
    // system. The download itself is the sensitive action — we record it
    // before sending the body so a network failure mid-stream still leaves a
    // trace.
    const q = req.query as Record<string, unknown>;
    await recordActivity(req, {
      engagementId: id,
      kind: "audit_export_downloaded",
      severity: "critical",
      message: `Activity CSV exported (${rows.length} rows)`,
      payload: {
        rowCount: rows.length,
        filters: {
          kind: q.kind ?? null,
          severity: q.severity ?? null,
          actor: q.actor ?? null,
          from: q.from ?? null,
          to: q.to ?? null,
        },
      },
    });
    res
      .status(200)
      .setHeader("content-type", "text/csv; charset=utf-8")
      .setHeader(
        "content-disposition",
        `attachment; filename="activity-${id}.csv"`,
      )
      .send(lines.join("\n") + "\n");
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
    await recordActivity(req, {
      engagementId: id,
      kind: "member_added",
      severity: "critical",
      message: `Added ${email} as ${role}`,
      payload: { email, role, memberId: member.id, linkedUserId: maybeUser?.id ?? null },
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
    await recordActivity(req, {
      engagementId: id,
      kind: "member_removed",
      severity: "critical",
      message: `Removed ${target.email} from the engagement`,
      payload: { email: target.email, role: target.role, memberId: target.id },
    });
    res.sendStatus(204);
  },
);

export default router;
