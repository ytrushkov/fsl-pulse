import { eq, desc } from "drizzle-orm";
import {
  db,
  connectorsTable,
  connectorRunsTable,
  engagementsTable,
  evidenceTable,
} from "@workspace/db";
import { decryptToken, encryptToken, isCurrentTokenFormat } from "./util";
import {
  runConnector as runConnectorImpl,
  DEFAULT_CONNECTOR_LOOKBACK_DAYS,
  DEFAULT_WALL_CLOCK_BUDGET_MS,
} from "./connectors";
import { recordActivity, recordSystemActivity } from "./audit";
import { logger } from "./logger";
import type { Request } from "express";

export interface ExecuteOpts {
  /** "manual" = invoked from POST /run with `req`; "scheduler" = background tick. */
  trigger: "manual" | "scheduler";
  req?: Request;
  requestId?: string;
}

/**
 * Shared executor for a single connector run. Used by both the manual
 * POST /connectors/:id/run endpoint and the background scheduler so the two
 * paths cannot drift in how they handle decryption, evidence persistence,
 * connector status updates, and audit logging.
 *
 * Returns the final connector_runs row (success or failed) and never throws —
 * any error is captured into the run row + connector.lastError + audit event.
 */
export async function executeConnectorRun(
  connectorId: string,
  opts: ExecuteOpts,
): Promise<typeof connectorRunsTable.$inferSelect | null> {
  const [c] = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.id, connectorId))
    .limit(1);
  if (!c) return null;

  // Resolve the engagement-level lookback window so every connector under
  // the engagement uses the same freshness/cost setting. Falls back to the
  // shared default if the engagement row is missing the column for any
  // reason (e.g. mid-migration on a stale read replica).
  const [eng] = await db
    .select({ connectorLookbackDays: engagementsTable.connectorLookbackDays })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, c.engagementId))
    .limit(1);
  const lookbackDays =
    eng?.connectorLookbackDays ?? DEFAULT_CONNECTOR_LOOKBACK_DAYS;
  const wallClockBudgetMs = DEFAULT_WALL_CLOCK_BUDGET_MS;

  // Read the most recent run's cursors so a budget-truncated run picks up
  // where it left off. We deliberately read regardless of prior status:
  // even a failed run may have written partial cursors before the error,
  // and resuming from there is strictly better than restarting from zero.
  const [lastRun] = await db
    .select({ cursors: connectorRunsTable.cursors })
    .from(connectorRunsTable)
    .where(eq(connectorRunsTable.connectorId, connectorId))
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(1);
  const priorCursors =
    (lastRun?.cursors as Record<string, unknown> | undefined) ?? {};

  const [run] = await db
    .insert(connectorRunsTable)
    .values({
      connectorId,
      status: "running",
      lookbackDays,
      wallClockBudgetMs,
    })
    .returning();
  await db
    .update(connectorsTable)
    .set({ status: "collecting", lastRunAt: new Date(), lastError: null })
    .where(eq(connectorsTable.id, connectorId));

  const audit = async (input: Parameters<typeof recordSystemActivity>[0]) => {
    if (opts.trigger === "manual" && opts.req) {
      await recordActivity(opts.req, input);
    } else {
      await recordSystemActivity({ ...input, requestId: opts.requestId });
    }
  };

  try {
    let token = "";
    if (c.encryptedToken) {
      try {
        token = decryptToken(c.encryptedToken);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "decryption failed";
        const [updated] = await db
          .update(connectorRunsTable)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error: `Token unreadable: ${msg}`,
          })
          .where(eq(connectorRunsTable.id, run.id))
          .returning();
        await db
          .update(connectorsTable)
          .set({ status: "failed", lastError: `Token unreadable: ${msg}` })
          .where(eq(connectorsTable.id, connectorId));
        await audit({
          engagementId: c.engagementId,
          kind: "connector_run_failed",
          severity: "critical",
          message: `Connector run failed for ${c.label}: token unreadable`,
          payload: { connectorId, runId: run.id, trigger: opts.trigger, error: msg },
        });
        return updated ?? null;
      }
      // Critical: every server-side use of a decrypted PAT (manual or
      // scheduled) is logged so compliance reviewers have a complete record.
      // Tagged with run id + connector id per PRD §6.2 so a token-misuse
      // investigation can pivot directly from audit row → run → evidence.
      await audit({
        engagementId: c.engagementId,
        kind: "connector_token_used",
        severity: "critical",
        message: `Token used to run ${c.label} (${opts.trigger})`,
        payload: {
          connectorId,
          runId: run.id,
          op: "run",
          provider: c.provider,
          trigger: opts.trigger,
        },
      });
      // Lazy migration: any legacy token format that decrypted successfully
      // is rewritten in the new KMS-backed envelope right now, then audited
      // separately so a compliance scan can confirm migration coverage. We
      // ignore failures here — the run itself already succeeded; a failed
      // re-encrypt just leaves the row in its older format for next time.
      if (!isCurrentTokenFormat(c.encryptedToken)) {
        try {
          const upgraded = encryptToken(token);
          await db
            .update(connectorsTable)
            .set({ encryptedToken: upgraded })
            .where(eq(connectorsTable.id, connectorId));
          await audit({
            engagementId: c.engagementId,
            kind: "connector_token_migrated",
            severity: "info",
            message: `Connector token re-encrypted into KMS envelope: ${c.label}`,
            payload: {
              connectorId,
              runId: run.id,
              trigger: opts.trigger,
              path: "lazy-on-read",
            },
          });
        } catch (err) {
          logger.warn(
            { err, connectorId },
            "lazy KMS re-encrypt failed; will retry next run",
          );
        }
      }
    }

    // Debounced incremental-checkpoint writer. Runners call this on every
    // iteration of long walks; we throttle DB writes to roughly one per
    // CHECKPOINT_MIN_INTERVAL_MS so a tight loop doesn't hammer Postgres
    // while still ensuring a kill/crash mid-walk leaves up-to-date
    // cursors+coverage on the run row for the next run to resume from.
    // Failures are swallowed so a transient DB blip never breaks the run.
    const CHECKPOINT_MIN_INTERVAL_MS = 5_000;
    let lastCheckpointMs = 0;
    let lastCheckpointCursors: Record<string, unknown> = priorCursors;
    let lastCheckpointCoverage: Record<string, unknown> = {};
    let lastCheckpointRecords = 0;
    const checkpoint = async (state: {
      cursors?: Record<string, unknown>;
      coverage?: Record<string, unknown>;
      recordsCollected?: number;
    }) => {
      if (state.cursors !== undefined) lastCheckpointCursors = state.cursors;
      if (state.coverage !== undefined) lastCheckpointCoverage = state.coverage;
      if (typeof state.recordsCollected === "number") {
        lastCheckpointRecords = state.recordsCollected;
      }
      const now = Date.now();
      if (now - lastCheckpointMs < CHECKPOINT_MIN_INTERVAL_MS) return;
      lastCheckpointMs = now;
      try {
        await db
          .update(connectorRunsTable)
          .set({
            cursors: lastCheckpointCursors,
            coverage: lastCheckpointCoverage,
            recordsCollected: lastCheckpointRecords,
          })
          .where(eq(connectorRunsTable.id, run.id));
      } catch (err) {
        logger.warn(
          { err, runId: run.id, connectorId },
          "connector run checkpoint persist failed",
        );
      }
    };

    const out = await runConnectorImpl(
      c.kind,
      c.provider,
      token,
      c.config as Record<string, unknown>,
      {
        requestId: opts.requestId,
        engagementId: c.engagementId,
        connectorLabel: c.label,
        lookbackDays,
        wallClockBudgetMs,
        priorCursors,
        checkpoint,
      },
    );

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
        // Persist resume state so the next run picks up where this one
        // stopped. Falls back to the prior cursors when the runner did not
        // produce any (e.g. ai_tooling has no resumable walk) so we never
        // accidentally wipe a useful cursor with an empty object.
        cursors: out.cursors ?? priorCursors,
        coverage: out.coverage ?? {},
      })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    // After a successful run — manual or scheduled — push nextRunAt forward
    // by the configured cadence. This prevents a manually-triggered run from
    // being immediately re-picked by the scheduler tick that may already be
    // due, and keeps cadence stable from the moment of the last success.
    const nextRun = new Date(
      Date.now() + (c.scheduleCadenceMinutes ?? 1440) * 60_000,
    );
    await db
      .update(connectorsTable)
      .set({
        status: "collected",
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
        nextRunAt: nextRun,
      })
      .where(eq(connectorsTable.id, connectorId));
    await audit({
      engagementId: c.engagementId,
      kind: "connector_run",
      message: `Collected ${out.recordsCollected} records from ${c.label} (${opts.trigger})`,
      payload: {
        connectorId,
        runId: run.id,
        recordsCollected: out.recordsCollected,
        trigger: opts.trigger,
      },
    });
    return updated ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, connectorId, trigger: opts.trigger }, "connector run failed");
    // On failure we deliberately keep the previous cursors visible on this
    // run row. Without this, every failure would zero out the cursor and a
    // genuinely-truncated previous run would never get its resumption
    // semantics; the next run would re-walk the same prefix.
    const [updated] = await db
      .update(connectorRunsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: msg,
        cursors: priorCursors,
      })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    // Important: do NOT delete or null prior evidence rows. The previous
    // signals remain visible (with their older createdAt) until the next
    // successful run replaces them.
    await db
      .update(connectorsTable)
      .set({ status: "failed", lastError: msg })
      .where(eq(connectorsTable.id, connectorId));
    await audit({
      engagementId: c.engagementId,
      kind: "connector_run_failed",
      message: `Connector run failed for ${c.label}: ${msg}`,
      payload: { connectorId, runId: run.id, trigger: opts.trigger, error: msg },
    });
    return updated ?? null;
  }
}
