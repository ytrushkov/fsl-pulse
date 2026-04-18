import { eq } from "drizzle-orm";
import {
  db,
  connectorsTable,
  connectorRunsTable,
  evidenceTable,
} from "@workspace/db";
import { decryptToken } from "./util";
import { runConnector as runConnectorImpl } from "./connectors";
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

  const [run] = await db
    .insert(connectorRunsTable)
    .values({ connectorId, status: "running" })
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
      await audit({
        engagementId: c.engagementId,
        kind: "connector_token_used",
        severity: "critical",
        message: `Token used to run ${c.label} (${opts.trigger})`,
        payload: {
          connectorId,
          op: "run",
          provider: c.provider,
          trigger: opts.trigger,
        },
      });
    }

    const out = await runConnectorImpl(
      c.kind,
      c.provider,
      token,
      c.config as Record<string, unknown>,
      { requestId: opts.requestId },
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
      })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    await db
      .update(connectorsTable)
      .set({
        status: "collected",
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
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
    const [updated] = await db
      .update(connectorRunsTable)
      .set({ status: "failed", finishedAt: new Date(), error: msg })
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
