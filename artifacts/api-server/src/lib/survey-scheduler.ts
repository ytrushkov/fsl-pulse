import { randomUUID } from "node:crypto";
import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  db,
  surveysTable,
  surveyInvitesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { recordSystemActivity } from "./audit";

const TICK_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 3600 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Survey nudge scheduler. Walks every open invite for surveys that have not
 * been closed and emits a `survey_invite_nudged` activity event for each
 * configured nudge day that has elapsed since the invite was created and has
 * not yet been recorded.
 *
 * Reminders are recorded as activity events rather than emails — the PRD
 * explicitly puts SMTP out of scope for v1, so the activity feed is the
 * delivery channel that downstream notification integrations can pick up.
 */
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const tickId = randomUUID();
  try {
    const surveys = await db
      .select({
        engagementId: surveysTable.engagementId,
        nudgeSchedule: surveysTable.nudgeSchedule,
        closedAt: surveysTable.closedAt,
      })
      .from(surveysTable)
      .where(isNull(surveysTable.closedAt));

    if (surveys.length === 0) return;

    let nudged = 0;
    for (const s of surveys) {
      const days = (s.nudgeSchedule as unknown as number[]) ?? [];
      if (!Array.isArray(days) || days.length === 0) continue;

      const invites = await db
        .select()
        .from(surveyInvitesTable)
        .where(
          and(
            eq(surveyInvitesTable.engagementId, s.engagementId),
            inArray(surveyInvitesTable.status, ["sent", "opened", "started"]),
          ),
        );

      for (const inv of invites) {
        const elapsedDays = Math.floor(
          (Date.now() - inv.createdAt.getTime()) / DAY_MS,
        );
        const sent = (inv.nudgesSent as unknown as number[]) ?? [];
        const due = days.filter(
          (d) => elapsedDays >= d && !sent.includes(d),
        );
        if (due.length === 0) continue;

        // Record one event per nudge day so the activity feed shows the
        // cadence accurately. Anonymous: only the team is recorded. Days
        // are only marked as `nudgesSent` once the activity row was
        // committed — otherwise a transient DB error would silently lose
        // the reminder forever.
        const persisted: number[] = [];
        for (const d of due) {
          const ok = await recordSystemActivity({
            engagementId: inv.engagementId,
            kind: "survey_invite_nudged",
            severity: "info",
            message: `Reminder queued for ${inv.team} (day ${d})`,
            payload: { team: inv.team, day: d, inviteId: inv.id },
          });
          if (ok) persisted.push(d);
        }
        if (persisted.length > 0) {
          await db
            .update(surveyInvitesTable)
            .set({ nudgesSent: [...sent, ...persisted] })
            .where(eq(surveyInvitesTable.id, inv.id));
          nudged += persisted.length;
        }
      }
    }

    if (nudged > 0) {
      logger.info({ tickId, nudged }, "survey scheduler tick: nudges emitted");
    }
  } catch (err) {
    logger.error({ err, tickId }, "survey scheduler tick failed");
  } finally {
    running = false;
  }
}

export function startSurveyScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    { intervalMs: TICK_INTERVAL_MS },
    "Survey nudge scheduler started",
  );
}

export function stopSurveyScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exported for tests.
export const __testing = { tick };

