import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db, connectorsTable } from "@workspace/db";
import { logger } from "./logger";
import { executeConnectorRun } from "./connector-runner";

const TICK_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Background scheduler tick. Picks up every connector whose `nextRunAt` is in
 * the past (and that has a token configured + scheduling enabled) and dispatches
 * a run. Each tick is bounded — we cap the batch at 25 connectors per minute so
 * a flood of due jobs cannot starve the event loop. Failures of individual
 * connectors are isolated; they update their own `lastError` and audit row but
 * never throw out of the tick.
 */
async function tick(): Promise<void> {
  if (running) return; // Reentrancy guard — slow runs must not stack ticks.
  running = true;
  const tickId = randomUUID();
  try {
    const due = await db
      .select({
        id: connectorsTable.id,
        engagementId: connectorsTable.engagementId,
        label: connectorsTable.label,
        cadence: connectorsTable.scheduleCadenceMinutes,
      })
      .from(connectorsTable)
      .where(
        and(
          eq(connectorsTable.scheduleEnabled, true),
          isNotNull(connectorsTable.encryptedToken),
          lte(connectorsTable.nextRunAt, new Date()),
        ),
      )
      .limit(25);

    if (due.length === 0) return;

    logger.info({ tickId, count: due.length }, "scheduler tick: dispatching runs");
    for (const c of due) {
      // Push nextRunAt forward immediately so a long-running job doesn't get
      // re-picked on the next tick. If the run fails the cadence still applies.
      const next = new Date(Date.now() + c.cadence * 60_000);
      await db
        .update(connectorsTable)
        .set({ nextRunAt: next })
        .where(eq(connectorsTable.id, c.id));
      try {
        await executeConnectorRun(c.id, {
          trigger: "scheduler",
          requestId: `sched-${tickId}`,
        });
      } catch (err) {
        logger.error(
          { err, connectorId: c.id, tickId },
          "scheduler: connector run threw",
        );
      }
    }
  } catch (err) {
    logger.error({ err, tickId }, "scheduler tick failed");
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  // Backfill nextRunAt = now() for any newly-enabled connectors that don't
  // have one yet, so they are picked up on the next tick rather than waiting
  // for an explicit PATCH.
  db.update(connectorsTable)
    .set({ nextRunAt: new Date() })
    .where(
      and(
        eq(connectorsTable.scheduleEnabled, true),
        sql`${connectorsTable.nextRunAt} IS NULL`,
      ),
    )
    .catch((err) => logger.error({ err }, "scheduler backfill failed"));

  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Connector scheduler started");
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
