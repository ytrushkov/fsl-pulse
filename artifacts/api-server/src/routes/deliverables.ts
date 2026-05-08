import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  deliverablesTable,
  deliverableVersionsTable,
  scoringTable,
  evidenceTable,
  usersTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { draftDeliverablesAi } from "../lib/ai-deliverables";
import { recordActivity } from "../lib/audit";
import { computeNpv, normalizeNpvInputs, type NpvInputs, type ActionItemSummary } from "../lib/npv-calc";

const router: IRouter = Router();

// Keys we version individually. Anything else passed in PATCH falls through
// to the row update without a snapshot row.
const VERSIONED_KEYS = [
  "heatmap",
  "gapAnalysis",
  "actionPlan",
  "entryPoint",
  "npv",
] as const;
type VersionedKey = (typeof VERSIONED_KEYS)[number];

function isVersionedKey(k: string): k is VersionedKey {
  return (VERSIONED_KEYS as readonly string[]).includes(k);
}

function shape(d: typeof deliverablesTable.$inferSelect) {
  return {
    engagementId: d.engagementId,
    statuses: d.statuses,
    heatmap: d.heatmap,
    gapAnalysis: d.gapAnalysis,
    actionPlan: d.actionPlan,
    entryPoint: d.entryPoint,
    npv: d.npv,
  };
}

interface LockEntry {
  lockedByName: string | null;
  lockedByEmail: string | null;
  lockedAt: string;
  version: number;
}

/**
 * Per-locked-key attribution. For every deliverable currently in `locked`
 * status, look up the most recent finalized version row and resolve the
 * author's display name from the users table (via authorEmail). Used by
 * the result pages to render a "Locked by {name}" badge so reviewers can
 * see who finalized each deliverable.
 */
async function buildLockMetadata(
  d: typeof deliverablesTable.$inferSelect,
): Promise<Record<string, LockEntry>> {
  const statuses = (d.statuses ?? {}) as Record<string, string>;
  const lockedKeys = VERSIONED_KEYS.filter((k) => statuses[k] === "locked");
  if (lockedKeys.length === 0) return {};
  const out: Record<string, LockEntry> = {};
  for (const key of lockedKeys) {
    const [latest] = await db
      .select({
        version: deliverableVersionsTable.version,
        authorEmail: deliverableVersionsTable.authorEmail,
        createdAt: deliverableVersionsTable.createdAt,
      })
      .from(deliverableVersionsTable)
      .where(
        and(
          eq(deliverableVersionsTable.engagementId, d.engagementId),
          eq(deliverableVersionsTable.deliverableKey, key),
          eq(deliverableVersionsTable.finalized, true),
        ),
      )
      .orderBy(desc(deliverableVersionsTable.version))
      .limit(1);
    if (!latest) continue;
    let lockedByName: string | null = null;
    if (latest.authorEmail) {
      const [u] = await db
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.email, latest.authorEmail))
        .limit(1);
      lockedByName = u?.name ?? null;
    }
    out[key] = {
      lockedByName,
      lockedByEmail: latest.authorEmail ?? null,
      lockedAt: latest.createdAt.toISOString(),
      version: latest.version,
    };
  }
  return out;
}

async function snapshotVersion(
  engagementId: string,
  key: VersionedKey,
  snapshot: unknown,
  authorEmail: string | null,
  finalized = false,
): Promise<number> {
  const [latest] = await db
    .select({ version: deliverableVersionsTable.version })
    .from(deliverableVersionsTable)
    .where(
      and(
        eq(deliverableVersionsTable.engagementId, engagementId),
        eq(deliverableVersionsTable.deliverableKey, key),
      ),
    )
    .orderBy(desc(deliverableVersionsTable.version))
    .limit(1);
  const next = (latest?.version ?? 0) + 1;
  await db.insert(deliverableVersionsTable).values({
    engagementId,
    deliverableKey: key,
    version: next,
    snapshot: snapshot as object,
    authorEmail,
    finalized,
  });
  return next;
}

router.get("/engagements/:id/deliverables", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [d] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  if (!d) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ...shape(d), lockMetadata: await buildLockMetadata(d) });
});

router.patch("/engagements/:id/deliverables", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const [existing] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Enforce server-side immutability: a locked deliverable can only be
  // un-locked through an explicit status transition (sent in `statuses`).
  // Silently ignore content edits on locked keys so a stale UI tab can't
  // overwrite a finalized snapshot via a direct API call.
  const statuses = (existing.statuses ?? {}) as Record<string, string>;
  const isLocked = (k: string) => statuses[k] === "locked";
  const set: Record<string, unknown> = {};
  if (b.statuses)
    set.statuses = { ...(existing.statuses as Record<string, unknown>), ...b.statuses };
  if (b.heatmap && !isLocked("heatmap")) set.heatmap = b.heatmap;
  if (b.gapAnalysis && !isLocked("gapAnalysis")) set.gapAnalysis = b.gapAnalysis;
  if (b.actionPlan && !isLocked("actionPlan")) set.actionPlan = b.actionPlan;
  if (b.entryPoint && !isLocked("entryPoint")) set.entryPoint = b.entryPoint;
  if (b.npv && !isLocked("npv")) set.npv = b.npv;
  const rejectedLocked = (
    ["heatmap", "gapAnalysis", "actionPlan", "entryPoint", "npv"] as const
  ).filter((k) => b[k] && isLocked(k));
  if (rejectedLocked.length > 0 && Object.keys(set).length === 0) {
    res.status(409).json({ error: "All targeted deliverables are locked", locked: rejectedLocked });
    return;
  }
  const [d] = await db
    .update(deliverablesTable)
    .set(set)
    .where(eq(deliverablesTable.engagementId, id))
    .returning();

  // Snapshot a new version row for every versioned field that was actually
  // touched, so the editor's history dropdown can revert to any prior save
  // and a finalize action can be tied back to a single immutable snapshot.
  const actor = req.authedUser!;
  for (const key of VERSIONED_KEYS) {
    if (key in set) {
      await snapshotVersion(id, key, set[key], actor.email);
    }
  }

  // Activity attribution for deliverable edits. Finalize/lock transitions
  // are recorded as critical so they stand out in the audit timeline.
  const prevStatuses = (existing.statuses ?? {}) as Record<string, string>;
  const nextStatuses = (b.statuses ?? {}) as Record<string, string>;
  const finalized = Object.entries(nextStatuses)
    .filter(
      ([k, v]) =>
        (v === "locked" || v === "finalized") && prevStatuses[k] !== v,
    )
    .map(([k]) => k);
  if (finalized.length > 0) {
    for (const deliverable of finalized) {
      await recordActivity(req, {
        engagementId: id,
        kind: "deliverable_finalized",
        severity: "critical",
        message: `Finalized ${deliverable} by ${actor.name || actor.email}`,
        payload: {
          deliverable,
          previousStatus: prevStatuses[deliverable] ?? "draft",
          newStatus: nextStatuses[deliverable],
        },
      });
    }
  } else {
    await recordActivity(req, {
      engagementId: id,
      kind: "deliverable_updated",
      message: "Updated deliverables",
      payload: { changedFields: Object.keys(set) },
    });
  }
  res.json({ ...shape(d), lockMetadata: await buildLockMetadata(d) });
});

router.post("/engagements/:id/deliverables/draft", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [scoring] = await db
    .select()
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, id));
  if (!scoring) {
    res.status(400).json({ error: "Compute scoring before drafting deliverables" });
    return;
  }
  const evidence = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.engagementId, id));
  const [existing] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  // Restrict regenerate to fields the assessor hasn't locked. Anything
  // already in the "locked" status keeps its hand-edited content so a
  // regenerate-from-evidence pass doesn't blow away approved narrative.
  const statuses = (existing?.statuses ?? {}) as Record<string, string>;
  const isLocked = (k: string) => statuses[k] === "locked";

  const drafted = await draftDeliverablesAi({
    scoring: {
      byDimension: scoring.byDimension as Array<{
        dimension: string;
        score: number;
        stage: number;
        confidence: string;
        evidenceIds: string[];
        rationale: string;
      }>,
      overall: scoring.overall as { score: number; stage: number; confidence: string },
    },
    evidence: evidence.map((e) => ({
      id: e.id,
      dimension: e.dimension,
      signalType: e.signalType,
      stageHint: e.stageHint,
      text: e.text,
    })),
    previousNpv: (existing?.npv as Record<string, unknown> | null) ?? null,
  }, { requestId: (req as typeof req & { id?: string }).id });
  const updates: Record<string, unknown> = {};
  if (!isLocked("heatmap")) updates.heatmap = drafted.heatmap;
  if (!isLocked("gapAnalysis")) updates.gapAnalysis = drafted.gapAnalysis;
  if (!isLocked("actionPlan")) updates.actionPlan = drafted.actionPlan;
  if (!isLocked("entryPoint")) updates.entryPoint = drafted.entryPoint;
  // NPV: regenerate only when not locked AND assessor hasn't supplied
  // custom inputs. Otherwise we recompute under the existing inputs so the
  // model stays aligned with their assumptions.
  if (!isLocked("npv")) {
    // Recompute NPV using the freshly-drafted action plan items so the
    // Business Case is aligned with the new action plan from the start.
    const draftedActionItems = resolveActionItems(
      { actionPlan: (updates.actionPlan ?? existing?.actionPlan) } as typeof deliverablesTable.$inferSelect,
    );
    const prevInputs = (existing?.npv as { inputs?: Partial<NpvInputs> } | null)?.inputs ?? {};
    updates.npv = computeNpv(prevInputs, draftedActionItems);
  }

  const [d] = await db
    .update(deliverablesTable)
    .set(updates)
    .where(eq(deliverablesTable.engagementId, id))
    .returning();

  const actor = req.authedUser!;
  for (const key of VERSIONED_KEYS) {
    if (key in updates) {
      await snapshotVersion(id, key, updates[key], actor.email);
    }
  }

  await recordActivity(req, {
    engagementId: id,
    kind: "deliverables_drafted",
    message: "Deliverables regenerated from latest evidence",
    payload: {
      regenerated: Object.keys(updates),
      lockedSkipped: VERSIONED_KEYS.filter(isLocked),
    },
  });
  res.json({ ...shape(d), lockMetadata: await buildLockMetadata(d) });
});

// ─── Versions ────────────────────────────────────────────────────────────

router.get(
  "/engagements/:id/deliverables/:key/versions",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const key = req.params.key;
    if (!id || !key || !isVersionedKey(key)) {
      res.status(400).json({ error: "Invalid id or key" });
      return;
    }
    const rows = await db
      .select()
      .from(deliverableVersionsTable)
      .where(
        and(
          eq(deliverableVersionsTable.engagementId, id),
          eq(deliverableVersionsTable.deliverableKey, key),
        ),
      )
      .orderBy(desc(deliverableVersionsTable.version));
    res.json(
      rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        key: r.deliverableKey,
        version: r.version,
        authorEmail: r.authorEmail,
        finalized: r.finalized,
        createdAt: r.createdAt.toISOString(),
        snapshot: r.snapshot,
      })),
    );
  },
);

router.post(
  "/engagements/:id/deliverables/:key/revert",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const key = req.params.key;
    const versionNum = Number.isInteger(req.body?.version)
      ? (req.body.version as number)
      : null;
    if (!id || !key || !isVersionedKey(key) || versionNum === null) {
      res.status(400).json({ error: "id, key, version (integer) required" });
      return;
    }
    const [existing] = await db
      .select()
      .from(deliverablesTable)
      .where(eq(deliverablesTable.engagementId, id));
    if (existing && ((existing.statuses ?? {}) as Record<string, string>)[key] === "locked") {
      res.status(409).json({ error: "Deliverable is locked" });
      return;
    }
    const [target] = await db
      .select()
      .from(deliverableVersionsTable)
      .where(
        and(
          eq(deliverableVersionsTable.engagementId, id),
          eq(deliverableVersionsTable.deliverableKey, key),
          eq(deliverableVersionsTable.version, versionNum),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const [d] = await db
      .update(deliverablesTable)
      .set({ [key]: target.snapshot })
      .where(eq(deliverablesTable.engagementId, id))
      .returning();
    const actor = req.authedUser!;
    const newVersion = await snapshotVersion(id, key, target.snapshot, actor.email);
    await recordActivity(req, {
      engagementId: id,
      kind: "deliverable_reverted",
      severity: "critical",
      message: `Reverted ${key} to version ${target.version} (now v${newVersion})`,
      payload: { key, fromVersion: target.version, newVersion },
    });
    res.json({ ...shape(d), lockMetadata: await buildLockMetadata(d) });
  },
);

/** Extract and normalize action items from a stored deliverables row. */
function resolveActionItems(
  existing: typeof deliverablesTable.$inferSelect | undefined,
): ActionItemSummary[] {
  if (!existing?.actionPlan) return [];
  const raw = existing.actionPlan as unknown[];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const i = item as Record<string, unknown>;
    const priority = i.priority as "P0" | "P1" | "P2" | undefined;
    const effort = i.effort as "S" | "M" | "L" | "XL" | undefined;
    if (!priority || !effort) return [];
    return [
      {
        id: String(i.id ?? ""),
        priority,
        effort,
        dimension: typeof i.dimension === "string" ? i.dimension : undefined,
        costEstimate: typeof i.costEstimate === "number" ? i.costEstimate : undefined,
        valueLever:
          i.valueLever === "cycle_time" || i.valueLever === "rework" || i.valueLever === "review"
            ? i.valueLever
            : undefined,
        expectedImpact: typeof i.expectedImpact === "number" ? i.expectedImpact : undefined,
      } satisfies ActionItemSummary,
    ];
  });
}

// ─── NPV recompute ───────────────────────────────────────────────────────

router.post(
  "/engagements/:id/npv/recompute",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(deliverablesTable)
      .where(eq(deliverablesTable.engagementId, id));
    if (existing && ((existing.statuses ?? {}) as Record<string, string>).npv === "locked") {
      res.status(409).json({ error: "NPV deliverable is locked" });
      return;
    }
    // OpenAPI body is the flat NpvInputs shape; tolerate a legacy `{inputs:{}}`
    // wrapper for older clients.
    const raw = (req.body?.inputs ?? req.body ?? {}) as Partial<NpvInputs>;
    const inputs = normalizeNpvInputs(raw);

    // Server always re-reads action plan items — the client never sends them.
    const actionItems = resolveActionItems(existing);

    const next = computeNpv(inputs, actionItems);
    // Pure recompute: this endpoint is read-only and does NOT persist or
    // snapshot a new version. The client splices the returned NpvResult
    // into its working state and only PATCH /deliverables (or finalize)
    // writes / versions. This keeps live what-if iteration cheap and
    // avoids polluting version history with every keystroke.
    res.json(next);
  },
);

// ─── Finalize ────────────────────────────────────────────────────────────

router.post(
  "/engagements/:id/deliverables/:key/finalize",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const key = req.params.key;
    if (!id || !key || !isVersionedKey(key)) {
      res.status(400).json({ error: "Invalid id or key" });
      return;
    }
    const [existing] = await db
      .select()
      .from(deliverablesTable)
      .where(eq(deliverablesTable.engagementId, id));
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const prevStatuses = (existing.statuses ?? {}) as Record<string, string>;
    if (prevStatuses[key] === "locked") {
      // Idempotent finalize: return the existing finalized snapshot row
      // without writing a duplicate version or audit entry.
      const [latestFinal] = await db
        .select()
        .from(deliverableVersionsTable)
        .where(
          and(
            eq(deliverableVersionsTable.engagementId, id),
            eq(deliverableVersionsTable.deliverableKey, key),
            eq(deliverableVersionsTable.finalized, true),
          ),
        )
        .orderBy(desc(deliverableVersionsTable.version))
        .limit(1);
      if (latestFinal) {
        res.json({
          id: latestFinal.id,
          engagementId: latestFinal.engagementId,
          key: latestFinal.deliverableKey,
          version: latestFinal.version,
          authorEmail: latestFinal.authorEmail,
          finalized: latestFinal.finalized,
          createdAt: latestFinal.createdAt.toISOString(),
          snapshot: latestFinal.snapshot,
        });
        return;
      }
    }
    const statuses = { ...prevStatuses, [key]: "locked" };
    await db
      .update(deliverablesTable)
      .set({ statuses })
      .where(eq(deliverablesTable.engagementId, id));
    const actor = req.authedUser!;
    const snap = (existing as Record<string, unknown>)[key];
    const newVersion = await snapshotVersion(id, key, snap, actor.email, true);
    await recordActivity(req, {
      engagementId: id,
      kind: "deliverable_finalized",
      severity: "critical",
      message: `Finalized ${key} by ${actor.name || actor.email}`,
      payload: { deliverable: key, version: newVersion },
    });
    const [row] = await db
      .select()
      .from(deliverableVersionsTable)
      .where(
        and(
          eq(deliverableVersionsTable.engagementId, id),
          eq(deliverableVersionsTable.deliverableKey, key),
          eq(deliverableVersionsTable.version, newVersion),
        ),
      );
    res.json({
      id: row!.id,
      engagementId: row!.engagementId,
      key: row!.deliverableKey,
      version: row!.version,
      authorEmail: row!.authorEmail,
      finalized: row!.finalized,
      createdAt: row!.createdAt.toISOString(),
      snapshot: row!.snapshot,
    });
  },
);

export default router;
