import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  connectorsTable,
  connectorRunsTable,
  evidenceTable,
} from "@workspace/db";
import { recordActivity } from "../lib/audit";
import {
  paramId,
  encryptToken,
  decryptToken,
  maskToken,
  checkSafeUrl,
} from "../lib/util";
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
  // SSRF guard: any user-supplied base URL must point at a public host.
  const cfg = (b.config ?? {}) as Record<string, unknown>;
  if (typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0) {
    const ssrf = checkSafeUrl(cfg.baseUrl);
    if (!ssrf.ok) {
      res.status(400).json({ error: `Invalid base URL: ${ssrf.reason}` });
      return;
    }
  }
  const [c] = await db
    .insert(connectorsTable)
    .values({
      engagementId: id,
      kind: b.kind,
      provider: b.provider,
      label: b.label,
      encryptedToken: b.token ? encryptToken(b.token) : null,
      config: cfg,
      status: b.token ? "configured" : "not_configured",
    })
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "connector_added",
    message: `Connector added: ${c.label} (${c.kind})`,
    payload: {
      connectorId: c.id,
      kind: c.kind,
      provider: c.provider,
      label: c.label,
      hasToken: Boolean(c.encryptedToken),
    },
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
  if ("config" in b) {
    const cfg = (b.config ?? {}) as Record<string, unknown>;
    if (typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0) {
      const ssrf = checkSafeUrl(cfg.baseUrl);
      if (!ssrf.ok) {
        res.status(400).json({ error: `Invalid base URL: ${ssrf.reason}` });
        return;
      }
    }
    set.config = cfg;
  }
  if ("token" in b && b.token) {
    set.encryptedToken = encryptToken(b.token);
    set.status = "configured";
  }
  const [previous] = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.id, id))
    .limit(1);
  const [c] = await db
    .update(connectorsTable)
    .set(set)
    .where(eq(connectorsTable.id, id))
    .returning();
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Token rotation is treated as critical — the previous PAT is no longer
  // recoverable and any future verify/run uses the new credential.
  const tokenRotated = Boolean(set.encryptedToken);
  await recordActivity(req, {
    engagementId: c.engagementId,
    kind: tokenRotated ? "connector_token_rotated" : "connector_updated",
    severity: tokenRotated ? "critical" : "info",
    message: tokenRotated
      ? `Token rotated for ${c.label}`
      : `Connector updated: ${c.label}`,
    payload: {
      connectorId: c.id,
      changedFields: Object.keys(set),
      labelBefore: previous?.label,
      labelAfter: c.label,
    },
  });
  res.json(shape(c));
});

router.delete("/connectors/:connectorId", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [doomed] = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.id, id))
    .limit(1);
  await db.delete(connectorsTable).where(eq(connectorsTable.id, id));
  if (doomed) {
    await recordActivity(req, {
      engagementId: doomed.engagementId,
      kind: "connector_deleted",
      severity: "critical",
      message: `Connector deleted: ${doomed.label}`,
      payload: { connectorId: doomed.id, label: doomed.label, kind: doomed.kind },
    });
  }
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
  let token = "";
  if (c.encryptedToken) {
    try {
      token = decryptToken(c.encryptedToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "decryption failed";
      res.status(400).json({
        ok: false,
        message: `Stored token is unreadable (${msg}); please re-enter the token.`,
      });
      return;
    }
  }
  // Critical: every server-side use of a decrypted PAT is logged so
  // compliance reviewers can answer "who used this credential, when, against
  // which provider?" without scanning raw application logs.
  await recordActivity(req, {
    engagementId: c.engagementId,
    kind: "connector_token_used",
    severity: "critical",
    message: `Token used to verify ${c.label}`,
    payload: { connectorId: c.id, op: "verify", provider: c.provider },
  });
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
    const token = c.encryptedToken ? decryptToken(c.encryptedToken) : "";
    if (c.encryptedToken) {
      await recordActivity(req, {
        engagementId: c.engagementId,
        kind: "connector_token_used",
        severity: "critical",
        message: `Token used to run ${c.label}`,
        payload: { connectorId: c.id, op: "run", provider: c.provider },
      });
    }
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
    await recordActivity(req, {
      engagementId: c.engagementId,
      kind: "connector_run",
      message: `Collected ${out.recordsCollected} records from ${c.label}`,
      payload: {
        connectorId: c.id,
        runId: run.id,
        recordsCollected: out.recordsCollected,
      },
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
    await recordActivity(req, {
      engagementId: c.engagementId,
      kind: "connector_run_failed",
      message: `Connector run failed for ${c.label}: ${msg}`,
      payload: { connectorId: c.id, runId: run.id, error: msg },
    });
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
