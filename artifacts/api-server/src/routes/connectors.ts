import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  connectorsTable,
  connectorRunsTable,
  evidenceTable,
  activityEventsTable,
} from "@workspace/db";
import { paramId, obfuscateToken, deobfuscateToken, maskToken } from "../lib/util";
import {
  runConnector as runConnectorImpl,
  verifyConnector as verifyConnectorImpl,
} from "../lib/connectors";
import { requireResourceMember } from "../middlewares/auth";

const router: IRouter = Router();

const requireConnectorMember = requireResourceMember({
  paramName: "connectorId",
  resolveEngagementId: async (id) => {
    const [row] = await db
      .select({ engagementId: connectorsTable.engagementId })
      .from(connectorsTable)
      .where(eq(connectorsTable.id, id))
      .limit(1);
    return row?.engagementId;
  },
});

function shape(c: typeof connectorsTable.$inferSelect) {
  const cfg = (c.config as Record<string, unknown>) ?? {};
  return {
    id: c.id,
    engagementId: c.engagementId,
    kind: c.kind,
    provider: c.provider,
    label: c.label,
    status: c.status,
    config: { ...cfg, tokenMask: maskToken(c.encryptedToken) },
    lastRunAt: c.lastRunAt?.toISOString() ?? null,
    lastError: c.lastError,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/engagements/:id/connectors", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.engagementId, id))
    .orderBy(desc(connectorsTable.createdAt));
  res.json(rows.map(shape));
});

router.post("/engagements/:id/connectors", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!b.kind || !b.provider || !b.label) {
    res.status(400).json({ error: "kind, provider, label required" });
    return;
  }
  const [c] = await db
    .insert(connectorsTable)
    .values({
      engagementId: id,
      kind: b.kind,
      provider: b.provider,
      label: b.label,
      encryptedToken: b.token ? obfuscateToken(b.token) : null,
      config: b.config ?? {},
      status: b.token ? "configured" : "not_configured",
    })
    .returning();
  const actor = req.authedUser!;
  await db.insert(activityEventsTable).values({
    engagementId: id,
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    kind: "connector_added",
    message: `Connector added: ${c.label} (${c.kind})`,
  });
  res.status(201).json(shape(c));
});

router.patch("/connectors/:connectorId", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  if ("label" in b) set.label = b.label;
  if ("config" in b) set.config = b.config;
  if ("token" in b && b.token) {
    set.encryptedToken = obfuscateToken(b.token);
    set.status = "configured";
  }
  const [c] = await db
    .update(connectorsTable)
    .set(set)
    .where(eq(connectorsTable.id, id))
    .returning();
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(shape(c));
});

router.delete("/connectors/:connectorId", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(connectorsTable).where(eq(connectorsTable.id, id));
  res.sendStatus(204);
});

router.post("/connectors/:connectorId/verify", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const token = c.encryptedToken ? deobfuscateToken(c.encryptedToken) : "";
  const result = await verifyConnectorImpl(c.kind, c.provider, token, c.config as Record<string, unknown>);
  res.json(result);
});

router.post("/connectors/:connectorId/run", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [run] = await db
    .insert(connectorRunsTable)
    .values({ connectorId: id, status: "running" })
    .returning();
  await db
    .update(connectorsTable)
    .set({ status: "collecting", lastRunAt: new Date(), lastError: null })
    .where(eq(connectorsTable.id, id));

  try {
    const token = c.encryptedToken ? deobfuscateToken(c.encryptedToken) : "";
    const out = await runConnectorImpl(
      c.kind,
      c.provider,
      token,
      c.config as Record<string, unknown>,
    );

    // Persist evidence rows derived from connector summary
    if (out.evidence && out.evidence.length > 0) {
      await db.insert(evidenceTable).values(
        out.evidence.map((e) => ({
          engagementId: c.engagementId,
          sourceType: "system" as const,
          sourceRef: `${c.kind}:${c.provider}:${c.id}`,
          dimension: e.dimension,
          signalType: e.signalType,
          stageHint: e.stageHint ?? null,
          text: e.text,
          createdBy: "system",
        })),
      );
    }
    const [updated] = await db
      .update(connectorRunsTable)
      .set({
        status: "success",
        finishedAt: new Date(),
        recordsCollected: out.recordsCollected,
        summary: out.summary,
      })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    await db
      .update(connectorsTable)
      .set({ status: "collected", lastRunAt: new Date(), lastError: null })
      .where(eq(connectorsTable.id, id));
    const actor = req.authedUser!;
    await db.insert(activityEventsTable).values({
      engagementId: c.engagementId,
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      kind: "connector_run",
      message: `Collected ${out.recordsCollected} records from ${c.label}`,
    });
    res.status(202).json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const [updated] = await db
      .update(connectorRunsTable)
      .set({ status: "failed", finishedAt: new Date(), error: msg })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    await db
      .update(connectorsTable)
      .set({ status: "failed", lastError: msg })
      .where(eq(connectorsTable.id, id));
    res.status(202).json(updated);
  }
});

router.get("/connectors/:connectorId/runs", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(connectorRunsTable)
    .where(eq(connectorRunsTable.connectorId, id))
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(50);
  res.json(rows);
});

export default router;
