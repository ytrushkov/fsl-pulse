import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  interviewsTable,
  evidenceTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { requireResourceMember } from "../middlewares/auth";
import { recordActivity } from "../lib/audit";

const router: IRouter = Router();

const requireInterviewMember = requireResourceMember({
  paramName: "interviewId",
  resolveEngagementId: async (id) => {
    const [row] = await db
      .select({ engagementId: interviewsTable.engagementId })
      .from(interviewsTable)
      .where(eq(interviewsTable.id, id))
      .limit(1);
    return row?.engagementId;
  },
});

const requireEvidenceMember = requireResourceMember({
  paramName: "evidenceId",
  resolveEngagementId: async (id) => {
    const [row] = await db
      .select({ engagementId: evidenceTable.engagementId })
      .from(evidenceTable)
      .where(eq(evidenceTable.id, id))
      .limit(1);
    return row?.engagementId;
  },
});

async function shape(i: typeof interviewsTable.$inferSelect) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(evidenceTable)
    .where(eq(evidenceTable.interviewId, i.id));
  return {
    id: i.id,
    engagementId: i.engagementId,
    interviewee: i.interviewee,
    role: i.role,
    date: i.date?.toISOString() ?? null,
    consent: i.consent,
    notes: i.notes,
    status: i.status,
    evidenceCount: Number(count),
    createdAt: i.createdAt.toISOString(),
  };
}

router.get("/engagements/:id/interviews", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(interviewsTable)
    .where(eq(interviewsTable.engagementId, id))
    .orderBy(desc(interviewsTable.createdAt));
  res.json(await Promise.all(rows.map(shape)));
});

router.post("/engagements/:id/interviews", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!b.interviewee || !b.role) {
    res.status(400).json({ error: "interviewee, role required" });
    return;
  }
  const [iv] = await db
    .insert(interviewsTable)
    .values({
      engagementId: id,
      interviewee: b.interviewee,
      role: b.role,
      date: b.date ? new Date(b.date) : null,
      consent: !!b.consent,
      notes: b.notes ?? "",
      status: "draft",
    })
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "interview_created",
    message: `Interview added: ${iv.interviewee} (${iv.role})`,
    payload: { interviewId: iv.id, interviewee: iv.interviewee, role: iv.role },
  });
  res.status(201).json(await shape(iv));
});

router.get("/interviews/:interviewId", requireInterviewMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.interviewId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [iv] = await db.select().from(interviewsTable).where(eq(interviewsTable.id, id));
  if (!iv) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(await shape(iv));
});

router.patch("/interviews/:interviewId", requireInterviewMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.interviewId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  for (const k of ["interviewee", "role", "consent", "notes", "status"]) {
    if (k in b) set[k] = b[k];
  }
  if ("date" in b) set.date = b.date ? new Date(b.date) : null;
  const [iv] = await db
    .update(interviewsTable)
    .set(set)
    .where(eq(interviewsTable.id, id))
    .returning();
  if (!iv) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordActivity(req, {
    engagementId: iv.engagementId,
    kind: "interview_updated",
    severity: "info",
    message: `Interview with ${iv.interviewee ?? "unknown"} updated`,
    payload: { interviewId: iv.id, fields: Object.keys(set) },
  });
  res.json(await shape(iv));
});

router.delete("/interviews/:interviewId", requireInterviewMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.interviewId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Read before delete so we can capture engagementId + interviewee for the audit row.
  const [existing] = await db
    .select()
    .from(interviewsTable)
    .where(eq(interviewsTable.id, id));
  await db.delete(interviewsTable).where(eq(interviewsTable.id, id));
  if (existing) {
    await recordActivity(req, {
      engagementId: existing.engagementId,
      kind: "interview_deleted",
      severity: "critical",
      message: `Interview with ${existing.interviewee ?? "unknown"} deleted`,
      payload: { interviewId: existing.id, interviewee: existing.interviewee },
    });
  }
  res.sendStatus(204);
});

router.get("/interviews/:interviewId/evidence", requireInterviewMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.interviewId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.interviewId, id))
    .orderBy(desc(evidenceTable.createdAt));
  res.json(rows);
});

router.post("/interviews/:interviewId/evidence", requireInterviewMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.interviewId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!b.dimension || !b.signalType || !b.text) {
    res.status(400).json({ error: "dimension, signalType, text required" });
    return;
  }
  const [iv] = await db.select().from(interviewsTable).where(eq(interviewsTable.id, id));
  if (!iv) {
    res.status(404).json({ error: "Interview not found" });
    return;
  }
  const [ev] = await db
    .insert(evidenceTable)
    .values({
      engagementId: iv.engagementId,
      interviewId: id,
      sourceType: "interview",
      sourceRef: id,
      dimension: b.dimension,
      signalType: b.signalType,
      stageHint: b.stageHint ?? null,
      text: b.text,
      createdBy: "assessor",
    })
    .returning();
  await recordActivity(req, {
    engagementId: iv.engagementId,
    kind: "evidence_added",
    severity: "info",
    message: `Evidence added to ${b.dimension} (${b.signalType})`,
    payload: {
      evidenceId: ev.id,
      interviewId: id,
      dimension: b.dimension,
      signalType: b.signalType,
    },
  });
  res.status(201).json(ev);
});

router.delete("/evidence/:evidenceId", requireEvidenceMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.evidenceId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.id, id));
  await db.delete(evidenceTable).where(eq(evidenceTable.id, id));
  if (existing) {
    await recordActivity(req, {
      engagementId: existing.engagementId,
      kind: "evidence_deleted",
      severity: "critical",
      message: `Evidence removed from ${existing.dimension}`,
      payload: {
        evidenceId: existing.id,
        dimension: existing.dimension,
        signalType: existing.signalType,
      },
    });
  }
  res.sendStatus(204);
});

export default router;
