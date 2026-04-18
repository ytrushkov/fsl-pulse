import type { Request } from "express";
import { db, activityEventsTable } from "@workspace/db";
import { logger } from "./logger";

export type ActivitySeverity = "info" | "critical";

export interface RecordActivityInput {
  engagementId: string;
  kind: string;
  message: string;
  payload?: Record<string, unknown>;
  severity?: ActivitySeverity;
}

/**
 * Single chokepoint for writing rows to `activity_events`. Pulls the actor
 * from `req.authedUser` and the request-id from `req.id` so every event is
 * automatically correlated with the request that produced it. State-changing
 * routes should call this instead of inserting into the table directly.
 *
 * Failures are logged but never thrown — auditing must not break user-facing
 * write paths. Callers may pass an explicit `engagementId` because some
 * endpoints (e.g. `POST /engagements`) don't have one in `req.params`.
 */
export async function recordActivity(
  req: Request,
  input: RecordActivityInput,
): Promise<void> {
  const actor = req.authedUser ?? null;
  const requestId =
    typeof req.id === "string" || typeof req.id === "number"
      ? String(req.id)
      : null;
  try {
    await db.insert(activityEventsTable).values({
      engagementId: input.engagementId,
      actorUserId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      kind: input.kind,
      message: input.message,
      payload: input.payload ?? {},
      severity: input.severity ?? "info",
      requestId,
    });
  } catch (err) {
    logger.error(
      { err, kind: input.kind, engagementId: input.engagementId, requestId },
      "Failed to record activity event",
    );
  }
}

/** Anonymous variant for public/magic-link routes that have no req.authedUser. */
export async function recordAnonymousActivity(
  req: Request,
  input: RecordActivityInput & { actorLabel?: string },
): Promise<void> {
  const requestId =
    typeof req.id === "string" || typeof req.id === "number"
      ? String(req.id)
      : null;
  try {
    await db.insert(activityEventsTable).values({
      engagementId: input.engagementId,
      actorUserId: null,
      actorName: input.actorLabel ?? "Anonymous respondent",
      actorEmail: null,
      kind: input.kind,
      message: input.message,
      payload: input.payload ?? {},
      severity: input.severity ?? "info",
      requestId,
    });
  } catch (err) {
    logger.error(
      { err, kind: input.kind, engagementId: input.engagementId, requestId },
      "Failed to record anonymous activity event",
    );
  }
}
