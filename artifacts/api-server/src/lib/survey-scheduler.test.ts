import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  engagementsTable,
  surveysTable,
  surveyInvitesTable,
} from "@workspace/db";
import { newToken, hashInviteToken } from "./util";

// Mock the audit module so we can simulate a DB failure during the
// `recordSystemActivity` write without touching the real activity_events
// table. The scheduler must treat `false` as "do not mark as nudged".
vi.mock("./audit", async (importActual) => {
  const actual = await importActual<typeof import("./audit")>();
  return {
    ...actual,
    recordSystemActivity: vi.fn(),
  };
});

import { recordSystemActivity } from "./audit";
import { __testing as schedulerTesting } from "./survey-scheduler";

async function seedDueInvite(): Promise<{
  engagementId: string;
  inviteId: string;
}> {
  const [eng] = await db
    .insert(engagementsTable)
    .values({
      clientName: `Scheduler Test ${randomUUID().slice(0, 8)}`,
      sponsor: "Sponsor",
      teamCount: 1,
    })
    .returning();
  const engagementId = eng!.id;
  // Survey with day-1 nudge so a single tick will see the day as due.
  await db
    .insert(surveysTable)
    .values({ engagementId, nudgeSchedule: [1] });
  const plain = newToken();
  const [invite] = await db
    .insert(surveyInvitesTable)
    .values({
      engagementId,
      team: "Engineering",
      token: hashInviteToken(plain),
      status: "sent",
    })
    .returning();
  // Backdate createdAt by 2 days so the day-1 nudge is definitely due.
  await db
    .update(surveyInvitesTable)
    .set({ createdAt: sql`now() - interval '2 days'` })
    .where(eq(surveyInvitesTable.id, invite!.id));
  return { engagementId, inviteId: invite!.id };
}

describe("survey scheduler reminder retry on DB failure", () => {
  beforeEach(() => {
    vi.mocked(recordSystemActivity).mockReset();
  });

  // Count only invocations for the given inviteId — the test DB may contain
  // unrelated due invites from other tests/runs, so global call-count
  // assertions (`toHaveBeenCalledTimes`) would be flaky.
  function callsForInvite(inviteId: string): number {
    return vi.mocked(recordSystemActivity).mock.calls.filter(
      ([arg]) => (arg.payload as { inviteId?: string } | undefined)?.inviteId === inviteId,
    ).length;
  }

  it("does NOT mark a nudge as sent when the activity write fails — so it is retried next tick", async () => {
    const { inviteId } = await seedDueInvite();

    // Simulate a transient DB error: recordSystemActivity returns false
    // (its contract on failure). The scheduler must not write `1` to
    // nudgesSent — otherwise the reminder is silently lost. We make
    // every call return false on this tick so any unrelated due invites
    // in the shared test DB don't change the behavior under test.
    vi.mocked(recordSystemActivity).mockResolvedValue(false);

    await schedulerTesting.tick();

    expect(callsForInvite(inviteId)).toBe(1);
    const [after] = await db
      .select()
      .from(surveyInvitesTable)
      .where(eq(surveyInvitesTable.id, inviteId));
    expect(after?.nudgesSent).toEqual([]);

    // Next tick succeeds → the day-1 nudge is finally recorded.
    vi.mocked(recordSystemActivity).mockResolvedValue(true);
    await schedulerTesting.tick();

    expect(callsForInvite(inviteId)).toBe(2);
    const [retried] = await db
      .select()
      .from(surveyInvitesTable)
      .where(eq(surveyInvitesTable.id, inviteId));
    expect(retried?.nudgesSent).toEqual([1]);
  });

  it("marks a nudge as sent when the activity write succeeds, and does not re-fire on subsequent ticks", async () => {
    const { inviteId } = await seedDueInvite();
    vi.mocked(recordSystemActivity).mockResolvedValue(true);

    await schedulerTesting.tick();
    const [first] = await db
      .select()
      .from(surveyInvitesTable)
      .where(eq(surveyInvitesTable.id, inviteId));
    expect(first?.nudgesSent).toEqual([1]);
    expect(callsForInvite(inviteId)).toBe(1);

    // A second tick should not re-emit the same day for this invite.
    await schedulerTesting.tick();
    expect(callsForInvite(inviteId)).toBe(1);
  });
});
