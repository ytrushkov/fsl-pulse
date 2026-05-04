import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
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
import { verifyConnector as verifyConnectorImpl } from "../lib/connectors";
import { executeConnectorRun } from "../lib/connector-runner";
import { requireResourceMember, requireEngagementMember } from "../middlewares/auth";

// Sane bounds for the per-engagement scheduler. 5 minutes is the floor so we
// can't accidentally hammer a third-party API; 30 days is the ceiling so a
// "forgotten" connector can't go silent for a year.
const MIN_CADENCE_MIN = 5;
const MAX_CADENCE_MIN = 60 * 24 * 30;

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
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    lastError: c.lastError,
    scheduleEnabled: c.scheduleEnabled,
    scheduleCadenceMinutes: c.scheduleCadenceMinutes,
    nextRunAt: c.nextRunAt?.toISOString() ?? null,
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
  // Schedule defaults are ON (daily) per task requirement. We must also
  // populate `nextRunAt = now()` at insert time, otherwise the scheduler's
  // `nextRunAt <= now()` filter will never select this row and the connector
  // will silently never auto-run. The scheduler does have a one-shot
  // backfill for legacy rows but it only runs at process boot, not on
  // create — relying on it would be incorrect.
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
      nextRunAt: new Date(),
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
  // Schedule controls. Validate cadence within bounds; whenever the schedule
  // is enabled (or its cadence changes) we set nextRunAt = now() so the next
  // tick picks it up promptly instead of waiting a full cadence window.
  let scheduleTouched = false;
  if ("scheduleEnabled" in b) {
    set.scheduleEnabled = Boolean(b.scheduleEnabled);
    scheduleTouched = true;
  }
  if ("scheduleCadenceMinutes" in b) {
    const cadence = Number(b.scheduleCadenceMinutes);
    if (
      !Number.isFinite(cadence) ||
      cadence < MIN_CADENCE_MIN ||
      cadence > MAX_CADENCE_MIN
    ) {
      res.status(400).json({
        error: `scheduleCadenceMinutes must be between ${MIN_CADENCE_MIN} and ${MAX_CADENCE_MIN}`,
      });
      return;
    }
    set.scheduleCadenceMinutes = cadence;
    scheduleTouched = true;
  }
  if (scheduleTouched && (set.scheduleEnabled ?? true)) {
    set.nextRunAt = new Date();
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

// Stateless verify used by the Add Connector wizard so the assessor can
// confirm a fresh credential before persisting it. Nothing is written to the
// DB by this route — the token is only forwarded to the provider's API.
router.post(
  "/engagements/:id/connectors/verify-config",
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body ?? {};
    const kind = typeof b.kind === "string" ? b.kind : "";
    const provider = typeof b.provider === "string" ? b.provider : "";
    const token = typeof b.token === "string" ? b.token : "";
    const cfg = (b.config ?? {}) as Record<string, unknown>;
    if (!kind || !provider) {
      res.status(400).json({ error: "kind and provider required" });
      return;
    }
    if (typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0) {
      const ssrf = checkSafeUrl(cfg.baseUrl);
      if (!ssrf.ok) {
        res.status(400).json({ error: `Invalid base URL: ${ssrf.reason}` });
        return;
      }
    }
    // Audit: even an unsaved verify uses a real PAT against a real provider,
    // so compliance still wants to see who tried what credential against what
    // engagement. We do NOT log the token itself, only that one was supplied.
    await recordActivity(req, {
      engagementId: id,
      kind: "connector_token_used",
      severity: "critical",
      message: `Token used to pre-verify ${kind}/${provider} (wizard)`,
      payload: { op: "verify_config", kind, provider, hasToken: Boolean(token) },
    });
    const result = await verifyConnectorImpl(kind, provider, token, cfg, {
      requestId: (req as typeof req & { id?: string }).id,
      engagementId: id,
    });
    res.json(result);
  },
);

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
  const result = await verifyConnectorImpl(
    c.kind,
    c.provider,
    token,
    c.config as Record<string, unknown>,
    {
      requestId: (req as typeof req & { id?: string }).id,
      engagementId: c.engagementId,
    },
  );
  res.json(result);
});

// Bulk-run every configured connector for an engagement. Skips connectors
// without a stored token (status === "not_configured") so we don't spam the
// run history with guaranteed-failed runs. Per-connector audit events are
// emitted by the shared executor; we additionally record a single parent
// `connectors_bulk_run` event so the activity timeline shows who fired the
// bulk and the aggregate outcome.
router.post(
  "/engagements/:id/connectors/run-all",
  requireEngagementMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = await db
      .select()
      .from(connectorsTable)
      .where(eq(connectorsTable.engagementId, id));

    const skipped = rows.filter((c) => c.status === "not_configured");
    const runnable = rows.filter((c) => c.status !== "not_configured");

    type Result = {
      connectorId: string;
      label: string;
      status: "success" | "failed" | "skipped";
      recordsCollected: number;
      error: string | null;
    };

    const skippedResults: Result[] = skipped.map((c) => ({
      connectorId: c.id,
      label: c.label,
      status: "skipped",
      recordsCollected: 0,
      error: "Connector not configured (no token)",
    }));

    // Run connectors in parallel — each targets a different external API and
    // executeConnectorRun never throws, so a slow/failed one cannot block the
    // others. The shared executor handles per-connector audit + status writes.
    const ranResults: Result[] = await Promise.all(
      runnable.map(async (c) => {
        const updated = await executeConnectorRun(c.id, {
          trigger: "manual",
          req,
          requestId: (req as typeof req & { id?: string }).id,
        });
        if (!updated) {
          return {
            connectorId: c.id,
            label: c.label,
            status: "failed" as const,
            recordsCollected: 0,
            error: "Connector disappeared mid-run",
          };
        }
        return {
          connectorId: c.id,
          label: c.label,
          status: updated.status === "success" ? "success" : "failed",
          recordsCollected: updated.recordsCollected ?? 0,
          error: updated.error ?? null,
        };
      }),
    );

    const results = [...ranResults, ...skippedResults];
    const succeeded = ranResults.filter((r) => r.status === "success").length;
    const failed = ranResults.filter((r) => r.status === "failed").length;

    await recordActivity(req, {
      engagementId: id,
      kind: "connectors_bulk_run",
      message: `Bulk-ran connectors: ${succeeded} succeeded, ${failed} failed, ${skipped.length} skipped`,
      payload: {
        totalConnectors: rows.length,
        triggered: runnable.length,
        succeeded,
        failed,
        skipped: skipped.length,
      },
    });

    res.status(202).json({
      totalConnectors: rows.length,
      triggered: runnable.length,
      succeeded,
      failed,
      skipped: skipped.length,
      results,
    });
  },
);

router.post("/connectors/:connectorId/run", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Delegate to the shared executor so manual + scheduled runs share the same
  // decryption / evidence / audit code path. Never throws; either returns the
  // final run row or null when the connector is missing.
  const updated = await executeConnectorRun(id, {
    trigger: "manual",
    req,
    requestId: (req as typeof req & { id?: string }).id,
  });
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(202).json(updated);
});

router.get("/connectors/:connectorId/runs", requireConnectorMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.connectorId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Pagination: default 25, hard cap 100. Long-lived engagements can
  // accumulate hundreds of run rows; the UI paginates so we don't ship the
  // whole history on every panel open.
  const limitRaw = Number(req.query.limit ?? 25);
  const offsetRaw = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  const rows = await db
    .select()
    .from(connectorRunsTable)
    .where(eq(connectorRunsTable.connectorId, id))
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(limit)
    .offset(offset);
  res.json(rows);
});

router.get(
  "/connectors/:connectorId/signals",
  requireConnectorMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.connectorId);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [c] = await db
      .select()
      .from(connectorsTable)
      .where(eq(connectorsTable.id, id))
      .limit(1);
    if (!c) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Latest run summary (raw provider counts) plus the evidence rows this
    // connector has authored. The UI uses this for the "view raw signals"
    // drawer; keeps assessors from having to dig through the evidence tab.
    const [latestRun] = await db
      .select()
      .from(connectorRunsTable)
      .where(eq(connectorRunsTable.connectorId, id))
      .orderBy(desc(connectorRunsTable.startedAt))
      .limit(1);
    const sourceRef = `${c.kind}:${c.provider}:${c.id}`;
    const evidence = await db
      .select()
      .from(evidenceTable)
      .where(
        and(
          eq(evidenceTable.engagementId, c.engagementId),
          eq(evidenceTable.sourceRef, sourceRef),
        ),
      )
      .orderBy(desc(evidenceTable.createdAt))
      .limit(100);
    res.json({
      connectorId: c.id,
      latestRun: latestRun ?? null,
      evidence: evidence.map((e) => ({
        id: e.id,
        dimension: e.dimension,
        signalType: e.signalType,
        stageHint: e.stageHint,
        text: e.text,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  },
);

export default router;
