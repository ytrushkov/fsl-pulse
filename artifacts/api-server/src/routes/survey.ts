import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  surveysTable,
  surveyInvitesTable,
  surveyResponsesTable,
  engagementsTable,
} from "@workspace/db";
import { paramId, newToken, hashInviteToken } from "../lib/util";
import { recordActivity, recordAnonymousActivity } from "../lib/audit";
import { DEFAULT_SURVEY_QUESTIONS } from "../lib/survey-template";

// Magic-link invite TTL. Configurable via env so ops can shorten for sensitive
// engagements without a code change.
const INVITE_TTL_MS = Number(
  process.env.PULSE_INVITE_TTL_MS ?? 30 * 24 * 3600 * 1000,
);

const ANONYMITY_FLOOR = 5;

const router: IRouter = Router();

// Single source of truth: serve live PRD template, filtered by enabled optional modules.
function questionsForEngagement(modules: string[] | null | undefined) {
  const enabled = new Set((modules ?? []) as string[]);
  return DEFAULT_SURVEY_QUESTIONS.filter(
    (q) => !q.moduleKey || enabled.has(q.moduleKey),
  );
}

router.get("/engagements/:id/survey", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [s] = await db.select().from(surveysTable).where(eq(surveysTable.engagementId, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const questions = questionsForEngagement(s.modules as string[]);
  res.json({
    engagementId: s.engagementId,
    templateVersion: s.templateVersion,
    modules: s.modules,
    questions,
    nudgeSchedule: s.nudgeSchedule,
    closedAt: s.closedAt,
  });
});

router.patch("/engagements/:id/survey", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  if (b.modules) set.modules = b.modules;
  if (b.questions) set.questions = b.questions;
  if (b.nudgeSchedule) {
    // Validate: array of positive integers, dedup + sort ascending so the
    // scheduler always receives a clean shape. Cap at 30 days so a bad UI
    // entry can't queue runaway reminders.
    if (!Array.isArray(b.nudgeSchedule)) {
      res.status(400).json({ error: "nudgeSchedule must be an array of days" });
      return;
    }
    const cleaned = Array.from(
      new Set(
        (b.nudgeSchedule as unknown[])
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 30),
      ),
    ).sort((a, b) => a - b);
    set.nudgeSchedule = cleaned;
  }
  const [s] = await db
    .update(surveysTable)
    .set(set)
    .where(eq(surveysTable.engagementId, id))
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "survey_template_updated",
    severity: "info",
    message: `Survey template updated (${Object.keys(set).join(", ") || "no changes"})`,
    payload: {
      fields: Object.keys(set),
      templateVersion: s.templateVersion,
    },
  });
  res.json({
    engagementId: s.engagementId,
    templateVersion: s.templateVersion,
    modules: s.modules,
    questions: s.questions,
    nudgeSchedule: s.nudgeSchedule,
    closedAt: s.closedAt,
  });
});

router.post("/engagements/:id/survey/close", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [s] = await db
    .update(surveysTable)
    .set({ closedAt: new Date() })
    .where(eq(surveysTable.engagementId, id))
    .returning();
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordActivity(req, {
    engagementId: id,
    kind: "survey_closed",
    severity: "critical",
    message: "Survey closed — dataset locked for scoring",
    payload: { closedAt: s.closedAt?.toISOString() },
  });
  res.json({
    engagementId: s.engagementId,
    templateVersion: s.templateVersion,
    modules: s.modules,
    questions: s.questions,
    nudgeSchedule: s.nudgeSchedule,
    closedAt: s.closedAt,
  });
});

router.get("/engagements/:id/survey/invites", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.engagementId, id));
  // Never expose the stored token hash. The plaintext is shown exactly once
  // at creation time (POST response) — assessors must save the magic link then.
  res.json(rows.map(({ token: _omit, ...rest }) => rest));
});

// CSV preview / dry-run. Validates each row and reports per-row errors so
// assessors can review before committing. Never writes to the DB.
router.post(
  "/engagements/:id/survey/invites/preview",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const csv = String(req.body?.csv ?? "");
    const parsed = parseInviteCsv(csv);
    res.json({
      validCount: parsed.filter((r) => r.valid).length,
      invalidCount: parsed.filter((r) => !r.valid).length,
      rows: parsed,
    });
  },
);

router.post("/engagements/:id/survey/invites", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!Array.isArray(b.invites) || b.invites.length === 0) {
    res.status(400).json({ error: "invites array required" });
    return;
  }
  // Block invite creation when the survey is locked.
  const [survey] = await db
    .select({ closedAt: surveysTable.closedAt })
    .from(surveysTable)
    .where(eq(surveysTable.engagementId, id));
  if (survey?.closedAt) {
    res.status(409).json({ error: "Survey is closed" });
    return;
  }
  // Generate plaintext tokens, persist only their hash + expiry, return the
  // plaintext to the assessor exactly once so they can mail the magic links.
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const minted: Array<{
    plain: string;
    values: {
      engagementId: string;
      team: string;
      role: string | null;
      emailHash: string | null;
      token: string;
      expiresAt: Date;
      status: string;
    };
  }> = b.invites.map((i: { team: string; email?: string; role?: string }) => {
    const plain = newToken();
    return {
      plain,
      values: {
        engagementId: id,
        team: i.team,
        role: i.role ?? null,
        emailHash: i.email
          ? createHash("sha256").update(i.email.toLowerCase()).digest("hex")
          : null,
        token: hashInviteToken(plain),
        expiresAt,
        status: "sent",
      },
    };
  });
  const rows = await db
    .insert(surveyInvitesTable)
    .values(minted.map((m) => m.values))
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "invites_sent",
    message: `Created ${rows.length} survey invites`,
    payload: {
      count: rows.length,
      teams: Array.from(new Set(rows.map((r) => r.team))),
      expiresAt: expiresAt.toISOString(),
    },
  });
  res.status(201).json(
    rows.map((r, i) => {
      const { token: _omit, ...rest } = r;
      return { ...rest, magicLinkToken: minted[i]!.plain };
    }),
  );
});

router.get("/engagements/:id/survey/responses", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const invites = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.engagementId, id));
  const responses = await db
    .select()
    .from(surveyResponsesTable)
    .where(eq(surveyResponsesTable.engagementId, id));

  const totalSent = invites.length;
  const totalCompleted = invites.filter((i) => i.status === "completed").length;
  const totalOpened = invites.filter((i) =>
    ["opened", "started", "completed"].includes(i.status),
  ).length;
  const totalStarted = invites.filter((i) =>
    ["started", "completed"].includes(i.status),
  ).length;
  const responseRate = totalSent > 0 ? totalCompleted / totalSent : 0;

  // By question distribution
  const qMap = new Map(DEFAULT_SURVEY_QUESTIONS.map((q) => [q.id, q]));
  const distMap = new Map<string, Map<string, number>>();
  const sumMap = new Map<string, { sum: number; n: number }>();
  for (const r of responses) {
    const ans = r.answers as Array<{ questionId: string; value: unknown }>;
    for (const a of ans) {
      if (!distMap.has(a.questionId)) distMap.set(a.questionId, new Map());
      const m = distMap.get(a.questionId)!;
      const key = String(a.value);
      m.set(key, (m.get(key) ?? 0) + 1);
      const num = typeof a.value === "number" ? a.value : Number(a.value);
      if (Number.isFinite(num)) {
        const s = sumMap.get(a.questionId) ?? { sum: 0, n: 0 };
        s.sum += num;
        s.n += 1;
        sumMap.set(a.questionId, s);
      }
    }
  }
  const byQuestion = Array.from(distMap.entries()).map(([qid, m]) => {
    const s = sumMap.get(qid);
    return {
      questionId: qid,
      average: s && s.n > 0 ? s.sum / s.n : null,
      distribution: Array.from(m.entries()).map(([value, count]) => ({ value, count })),
    };
  });

  // By team. We need invitedCount per team so the dashboard can render a
  // completion bar (completed / invited) and not just a count.
  const invitedByTeam = new Map<string, number>();
  for (const inv of invites) {
    invitedByTeam.set(inv.team, (invitedByTeam.get(inv.team) ?? 0) + 1);
  }
  const teamMap = new Map<string, typeof responses>();
  for (const r of responses) {
    if (!teamMap.has(r.team)) teamMap.set(r.team, [] as unknown as typeof responses);
    teamMap.get(r.team)!.push(r);
  }
  // Make sure teams that were invited but had zero completions still appear
  // (otherwise they silently vanish from the breakdown).
  for (const team of invitedByTeam.keys()) {
    if (!teamMap.has(team)) teamMap.set(team, [] as unknown as typeof responses);
  }
  const byTeam = Array.from(teamMap.entries()).map(([team, rs]) => {
    const completedCount = rs.length;
    const invitedCount = invitedByTeam.get(team) ?? 0;
    const suppressed = completedCount < ANONYMITY_FLOOR;
    if (suppressed) {
      // Omit `completedCount` for suppressed cells. Returning the exact
      // sub-floor count is itself an anonymity leak (it tells the assessor
      // a team has "3 respondents" rather than "fewer than 5"). The cell is
      // still listed so the assessor knows which teams exist, but no
      // metric is attached. `invitedCount` is safe to expose since it is
      // public information (the assessor sent the invites).
      return { team, completedCount: null, invitedCount, suppressed: true };
    }
    const dimSums: Record<string, { sum: number; n: number }> = {};
    for (const r of rs) {
      const ans = r.answers as Array<{ questionId: string; value: unknown }>;
      for (const a of ans) {
        const q = qMap.get(a.questionId);
        if (!q?.dimension || q.type !== "likert") continue;
        const v = typeof a.value === "number" ? a.value : Number(a.value);
        if (!Number.isFinite(v)) continue;
        const s = dimSums[q.dimension] ?? { sum: 0, n: 0 };
        s.sum += v;
        s.n += 1;
        dimSums[q.dimension] = s;
      }
    }
    const dimensionAverages: Record<string, number> = {};
    for (const [d, s] of Object.entries(dimSums)) {
      dimensionAverages[d] = Number((s.sum / s.n).toFixed(2));
    }
    return {
      team,
      completedCount,
      invitedCount,
      suppressed: false,
      dimensionAverages,
    };
  });

  // By role — derived from invite-time role on completed invites. Each cell
  // honors the anonymity floor independently of the per-team breakdown.
  const inviteById = new Map(invites.map((i) => [i.id, i]));
  const roleMap = new Map<string, number>();
  for (const r of responses) {
    const inv = inviteById.get(r.inviteId);
    const role = inv?.role ?? "Unknown";
    roleMap.set(role, (roleMap.get(role) ?? 0) + 1);
  }
  const byRole = Array.from(roleMap.entries()).map(([role, completedCount]) => {
    const suppressed = completedCount < ANONYMITY_FLOOR;
    return {
      role,
      // Same suppression discipline as byTeam: never expose the exact
      // sub-floor count. The cell is shown so the assessor knows the role
      // exists; the metric is hidden.
      completedCount: suppressed ? null : completedCount,
      suppressed,
    };
  });

  // Funnel (counts; ratio computed client-side). Anonymity floor does not
  // apply at the engagement level, only at per-segment cells.
  const funnel = {
    sent: totalSent,
    opened: totalOpened,
    started: totalStarted,
    completed: totalCompleted,
  };

  // Suppress per-question aggregates when total responses < 5.
  const aggregateSuppressed = totalCompleted < ANONYMITY_FLOOR;
  res.json({
    responseRate,
    totalSent,
    totalCompleted,
    aggregateSuppressed,
    byQuestion: aggregateSuppressed ? [] : byQuestion,
    byTeam,
    byRole,
    funnel,
  });
});

router.get("/survey/respond/:token", async (req, res): Promise<void> => {
  const token = paramId(req.params.token);
  if (!token) {
    res.status(400).json({ error: "Link is invalid or has expired" });
    return;
  }
  const [inv] = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.token, hashInviteToken(token)));
  if (!inv) {
    res.status(404).json({ error: "Link is invalid or has expired" });
    return;
  }
  const expired =
    !!inv.expiresAt && inv.expiresAt.getTime() < Date.now();
  const [eng] = await db
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, inv.engagementId));
  const [survey] = await db
    .select()
    .from(surveysTable)
    .where(eq(surveysTable.engagementId, inv.engagementId));
  // Only flip the invite to "opened" while the link is genuinely usable.
  // Once the survey is closed or the link has expired we freeze invite
  // state so post-close visits don't continue to mutate engagement metrics.
  if (
    !expired &&
    !survey?.closedAt &&
    inv.status !== "completed" &&
    inv.status === "sent"
  ) {
    await db
      .update(surveyInvitesTable)
      .set({ status: "opened" })
      .where(eq(surveyInvitesTable.id, inv.id));
    await recordAnonymousActivity(req, {
      engagementId: inv.engagementId,
      kind: "survey_invite_opened",
      severity: "info",
      message: `Survey link opened (${inv.team ?? "unassigned"})`,
      payload: { team: inv.team },
    });
  }
  const questions = questionsForEngagement(survey?.modules as string[]);
  // Status precedence: completed > closed > expired > open. The respondent
  // sees a friendly state for each branch instead of a generic 404 — the
  // "completed" path is checked first so a completed-then-expired link
  // still shows the thank-you screen rather than nagging about expiry.
  let status: "open" | "completed" | "expired" | "closed" = "open";
  if (inv.status === "completed") status = "completed";
  else if (survey?.closedAt) status = "closed";
  else if (expired) status = "expired";
  res.json({
    engagementClient: eng?.clientName ?? "",
    status,
    questions,
    savedAnswers: status === "open" ? (inv.partialAnswers ?? []) : [],
  });
});

router.post("/survey/respond/:token/draft", async (req, res): Promise<void> => {
  const token = paramId(req.params.token);
  if (!token) {
    res.status(400).json({ error: "Link is invalid or has expired" });
    return;
  }
  const b = req.body ?? {};
  if (!Array.isArray(b.answers)) {
    res.status(400).json({ error: "answers required" });
    return;
  }
  const [inv] = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.token, hashInviteToken(token)));
  if (!inv) {
    res.status(404).json({ error: "Link is invalid or has expired" });
    return;
  }
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: "Link is invalid or has expired" });
    return;
  }
  if (inv.status === "completed") {
    res.status(409).json({ error: "Already submitted" });
    return;
  }
  const [survey] = await db
    .select({ closedAt: surveysTable.closedAt })
    .from(surveysTable)
    .where(eq(surveysTable.engagementId, inv.engagementId));
  if (survey?.closedAt) {
    res.status(410).json({ error: "Survey is closed" });
    return;
  }
  // Don't fire activity events on every keystroke — autosave is high-volume
  // and would flood the feed. We only mark status `started` once on first save.
  const updates: Record<string, unknown> = {
    partialAnswers: b.answers,
    lastSavedAt: new Date(),
  };
  if (inv.status === "sent" || inv.status === "opened") {
    updates.status = "started";
  }
  await db
    .update(surveyInvitesTable)
    .set(updates)
    .where(eq(surveyInvitesTable.id, inv.id));
  res.sendStatus(204);
});

router.post("/survey/respond/:token", async (req, res): Promise<void> => {
  const token = paramId(req.params.token);
  if (!token) {
    res.status(400).json({ error: "Link is invalid or has expired" });
    return;
  }
  const b = req.body ?? {};
  if (!Array.isArray(b.answers)) {
    res.status(400).json({ error: "answers required" });
    return;
  }
  const [inv] = await db
    .select()
    .from(surveyInvitesTable)
    .where(eq(surveyInvitesTable.token, hashInviteToken(token)));
  if (!inv) {
    res.status(404).json({ error: "Link is invalid or has expired" });
    return;
  }
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: "Link is invalid or has expired" });
    return;
  }
  if (inv.status === "completed") {
    res.status(409).json({ error: "Already submitted" });
    return;
  }
  const [survey] = await db
    .select({ closedAt: surveysTable.closedAt })
    .from(surveysTable)
    .where(eq(surveysTable.engagementId, inv.engagementId));
  if (survey?.closedAt) {
    res.status(410).json({ error: "Survey is closed" });
    return;
  }
  await db.insert(surveyResponsesTable).values({
    inviteId: inv.id,
    engagementId: inv.engagementId,
    team: inv.team,
    answers: b.answers,
    demographics: b.demographics ?? {},
  });
  await db
    .update(surveyInvitesTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      // Clear partial answers once submitted so we never retain redundant
      // copies of the response payload.
      partialAnswers: [],
    })
    .where(eq(surveyInvitesTable.id, inv.id));
  await recordAnonymousActivity(req, {
    engagementId: inv.engagementId,
    kind: "survey_response_submitted",
    message: `Survey response submitted (team: ${inv.team})`,
    payload: { team: inv.team, inviteId: inv.id },
    actorLabel: `Respondent (${inv.team})`,
  });
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser for invite preview. Tolerant of header rows and stray
// whitespace. Schema: team[, email[, role]]. We deliberately avoid a full
// CSV library for v1 — the input is assessor-pasted text, not arbitrary
// uploads, and rows that fail parsing are reported with `valid: false`.
// Quoted fields containing commas are NOT supported; if a value needs a
// comma the assessor should rename it before pasting.
// ─────────────────────────────────────────────────────────────────────────────
function parseInviteCsv(csv: string): Array<{
  line: number;
  valid: boolean;
  team: string | null;
  email: string | null;
  role: string | null;
  error: string | null;
}> {
  const lines = csv.split(/\r?\n/);
  const out: ReturnType<typeof parseInviteCsv> = [];
  const seenEmails = new Set<string>();
  let isFirst = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    const cols = raw.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    // Skip a header row of "team,email,role" or similar — only on the first
    // non-empty line, so a literal team named "team" later in the file is
    // still treated as data.
    if (
      isFirst &&
      cols[0] &&
      ["team", "teams"].includes(cols[0].toLowerCase())
    ) {
      isFirst = false;
      continue;
    }
    isFirst = false;
    const [team, email, role] = cols;
    if (!team) {
      out.push({
        line: i + 1,
        valid: false,
        team: null,
        email: email ?? null,
        role: role ?? null,
        error: "Missing team",
      });
      continue;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      out.push({
        line: i + 1,
        valid: false,
        team,
        email,
        role: role ?? null,
        error: "Invalid email",
      });
      continue;
    }
    if (email) {
      const lower = email.toLowerCase();
      if (seenEmails.has(lower)) {
        out.push({
          line: i + 1,
          valid: false,
          team,
          email,
          role: role ?? null,
          error: "Duplicate email in batch",
        });
        continue;
      }
      seenEmails.add(lower);
    }
    out.push({
      line: i + 1,
      valid: true,
      team,
      email: email ?? null,
      role: role ?? null,
      error: null,
    });
  }
  return out;
}

export default router;
