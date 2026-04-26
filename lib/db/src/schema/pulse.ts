import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  boolean,
  doublePrecision,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").unique(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: ["admin", "assessor", "viewer"] })
      .notNull()
      .default("assessor"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
    clerkIdx: index("users_clerk_idx").on(t.clerkUserId),
  }),
);

export const engagementsTable = pgTable("engagements", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientName: text("client_name").notNull(),
  sponsor: text("sponsor").notNull(),
  teamCount: integer("team_count").notNull().default(1),
  scope: text("scope").notNull().default(""),
  // Optional client industry tag (e.g. "fintech", "healthcare", "retail").
  // Drives portfolio dashboard filtering and the anonymized benchmark CSV
  // export. Nullable so legacy engagements created before the portfolio
  // shipped don't have to be backfilled.
  industry: text("industry"),
  teams: text("teams").array().notNull().default([]),
  modules: text("modules").array().notNull().default([]),
  kickoffDate: timestamp("kickoff_date", { withTimezone: true }),
  targetDeliveryDate: timestamp("target_delivery_date", { withTimezone: true }),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const engagementMembersTable = pgTable(
  "engagement_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "assessor", "viewer"] })
      .notNull()
      .default("assessor"),
    invitedBy: uuid("invited_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    engIdx: index("engagement_members_engagement_idx").on(t.engagementId),
    emailIdx: index("engagement_members_email_idx").on(t.email),
    userIdx: index("engagement_members_user_idx").on(t.userId),
  }),
);

export const connectorsTable = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    encryptedToken: text("encrypted_token"),
    config: jsonb("config").notNull().default({}),
    status: text("status").notNull().default("not_configured"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Background scheduler controls. When `scheduleEnabled` is true the
    // server-side runner picks up this connector every `scheduleCadenceMinutes`
    // (default 1440 = daily) and writes a connector_runs row exactly as if
    // POST /connectors/:id/run had been invoked. `nextRunAt` is the watermark
    // the scheduler queries against; it is bumped after each tick.
    // Default ON so adding a connector is a one-step action: configure it,
    // and the scheduler keeps signals fresh on a daily cadence without the
    // assessor having to remember a follow-up step. They can disable later.
    scheduleEnabled: boolean("schedule_enabled").notNull().default(true),
    scheduleCadenceMinutes: integer("schedule_cadence_minutes")
      .notNull()
      .default(1440),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engIdx: index("connectors_engagement_idx").on(t.engagementId),
    // Partial-ish index used by the scheduler tick: pick connectors that are
    // due (`schedule_enabled = true AND next_run_at <= now()`). Drizzle
    // doesn't model partial indexes here, but a plain btree on next_run_at
    // is enough since the scheduler runs once a minute on a small table.
    nextRunIdx: index("connectors_next_run_idx").on(t.nextRunAt),
  }),
);

export const connectorRunsTable = pgTable(
  "connector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectorsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsCollected: integer("records_collected").notNull().default(0),
    error: text("error"),
    summary: jsonb("summary").notNull().default({}),
  },
  (t) => ({ cIdx: index("connector_runs_connector_idx").on(t.connectorId) }),
);

export const surveysTable = pgTable("surveys", {
  engagementId: uuid("engagement_id")
    .primaryKey()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  templateVersion: text("template_version").notNull().default("1.0.0"),
  modules: text("modules").array().notNull().default([]),
  questions: jsonb("questions").notNull().default([]),
  nudgeSchedule: jsonb("nudge_schedule").notNull().default([3, 7]),
  // Once set, the survey is locked: no new responses, no new invites, no
  // partial drafts saved. Used by the "Close survey" action so assessors can
  // freeze the dataset before scoring without deleting magic links.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const surveyInvitesTable = pgTable(
  "survey_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    team: text("team").notNull(),
    // Optional role coarse-bucket captured at invite time (e.g. "Engineer",
    // "Manager"). Used for the demographic mix breakdown — never paired with
    // the token or response, only counted against the anonymity floor.
    role: text("role"),
    emailHash: text("email_hash"),
    // Stored value is HMAC-SHA256(plaintext, EXPORT_KEY). The plaintext token
    // is returned to the assessor exactly once at creation time (POST response)
    // so they can build the magic link; thereafter we never see it again.
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("sent"),
    // Days (relative to createdAt) on which a reminder has already been
    // emitted, e.g. [3] means the day-3 nudge fired. Prevents the scheduler
    // from re-nudging on every tick.
    nudgesSent: jsonb("nudges_sent").notNull().default([]),
    // Server-side autosave for save-and-resume. Stores the same shape as a
    // submitted answers payload but never moves into surveyResponsesTable
    // until the respondent submits.
    partialAnswers: jsonb("partial_answers").notNull().default([]),
    lastSavedAt: timestamp("last_saved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    engIdx: index("survey_invites_engagement_idx").on(t.engagementId),
    tokIdx: index("survey_invites_token_idx").on(t.token),
  }),
);

export const surveyResponsesTable = pgTable(
  "survey_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => surveyInvitesTable.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    team: text("team").notNull(),
    answers: jsonb("answers").notNull().default([]),
    demographics: jsonb("demographics").notNull().default({}),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("survey_responses_engagement_idx").on(t.engagementId) }),
);

export const interviewsTable = pgTable(
  "interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    interviewee: text("interviewee").notNull(),
    role: text("role").notNull(),
    date: timestamp("date", { withTimezone: true }),
    consent: boolean("consent").notNull().default(false),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("interviews_engagement_idx").on(t.engagementId) }),
);

export const evidenceTable = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    interviewId: uuid("interview_id").references(() => interviewsTable.id, {
      onDelete: "cascade",
    }),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    dimension: text("dimension").notNull(),
    signalType: text("signal_type").notNull(),
    stageHint: integer("stage_hint"),
    text: text("text").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engIdx: index("evidence_engagement_idx").on(t.engagementId),
    intIdx: index("evidence_interview_idx").on(t.interviewId),
  }),
);

export const artifactDocsTable = pgTable(
  "artifact_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    kind: text("kind").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    content: text("content").notNull().default(""),
    extractedSummary: text("extracted_summary").notNull().default(""),
    // MIME type of the original uploaded file. Defaults to text/plain so legacy
    // rows (where content was the whole document) keep working.
    mimeType: text("mime_type").notNull().default("text/plain"),
    // Object storage path of the original file bytes (e.g.
    // `/objects/uploads/<uuid>`). Set when the user uploads a binary
    // (PDF/DOCX/etc) — bytes live in App Storage, not Postgres, so the
    // database stays lean and we can store documents larger than the old
    // 25 MB inline-base64 cap. Empty string means there is no separate
    // binary (paste-only uploads, where the download endpoint falls back
    // to streaming `content` as text/plain).
    objectKey: text("object_key").notNull().default(""),
    // DEPRECATED — kept in the schema only so that `drizzle-kit push` on
    // upgrade does not auto-drop the column before the runtime backfill
    // (`migrateLegacyArtifactBlobs`) has had a chance to copy any
    // remaining bytes into object storage. The backfill drops this
    // column itself once every row is migrated. Once production has
    // been confirmed clean, remove this field in a follow-up.
    dataBase64: text("data_base64"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("artifact_docs_engagement_idx").on(t.engagementId) }),
);

// Server-issued upload intents that bind a presigned object-storage URL to
// the engagement and user that requested it. Without this gate, knowing
// (or guessing) any `/objects/uploads/<uuid>` would let an attacker
// register that object as their own artifact and read it back through the
// authorized download endpoint — a BOLA. At create-artifact time we look
// up an unconsumed, non-expired intent matching (engagementId, userId,
// objectKey), then mark it consumed so the same key can't be re-used.
export const artifactUploadIntentsTable = pgTable(
  "artifact_upload_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    keyIdx: index("artifact_upload_intents_key_idx").on(t.objectKey),
    engIdx: index("artifact_upload_intents_engagement_idx").on(t.engagementId),
  }),
);

// Versioned rubrics. The shipped v1.0.0 is bootstrapped on first server
// start; practice leads can author additional drafts in the admin UI and
// publish them. Published rows are immutable. Each engagement's scoring is
// pinned to whichever rubric version produced its scores via
// `scoringTable.rubricVersionId`, so historical scorings stay reproducible
// even after a newer version ships.
export const rubricVersionsTable = pgTable(
  "rubric_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Human-readable semver-style label. Not unique on its own — a draft
    // can hold the same `version` string as a published row of the same
    // major number while it's being edited; uniqueness is only enforced
    // among `published` rows via a partial index in application logic.
    version: text("version").notNull(),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    // Full rubric body: { dimensions: DimensionRubric[], dimensionWeights?:
    // Record<Dimension, number> }. dimensionWeights default to 1.0 each
    // when omitted; they multiply each dimension's contribution to the
    // overall score so a version can re-weight without changing
    // per-dimension math.
    body: jsonb("body").notNull().default({}),
    notes: text("notes").notNull().default(""),
    createdByEmail: text("created_by_email"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index("rubric_versions_status_idx").on(t.status),
  }),
);

// Monthly snapshot of an engagement's overall scoring. Captured every time
// `computeEngagementScoring` persists, keyed by `(engagementId, snapshotMonth)`
// so each engagement contributes at most one row per month and the latest
// recompute in a month overwrites the earlier one. Drives the Portfolio
// "Where our clients are" stage-distribution history strip — the playhead
// reads one month's row per engagement and bins them into stage columns.
//
// `snapshotMonth` is a YYYY-MM-01 date in UTC; we store it as a real date
// (not a string) so range queries work with normal SQL operators.
export const engagementScoringSnapshotsTable = pgTable(
  "engagement_scoring_snapshots",
  {
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    snapshotMonth: timestamp("snapshot_month", { withTimezone: true }).notNull(),
    overallStage: integer("overall_stage").notNull(),
    overallScore: doublePrecision("overall_score").notNull(),
    byDimensionStages: jsonb("by_dimension_stages").notNull().default({}),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.engagementId, t.snapshotMonth] }),
    monthIdx: index("engagement_scoring_snapshots_month_idx").on(t.snapshotMonth),
  }),
);

export const scoringTable = pgTable("scoring", {
  engagementId: uuid("engagement_id")
    .primaryKey()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  rubricVersion: text("rubric_version").notNull().default("1.0.0"),
  // Hard pin to the rubric_versions row whose body was used. Nullable so
  // pre-existing scorings (created before versioning shipped) still load;
  // they're treated as "v1.0.0 (legacy)".
  rubricVersionId: uuid("rubric_version_id").references(
    () => rubricVersionsTable.id,
    { onDelete: "set null" },
  ),
  byDimension: jsonb("by_dimension").notNull().default([]),
  overall: jsonb("overall").notNull().default({}),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-dimension human narrative the assessor writes alongside the AI
// rationale. Lives in its own table so it survives every recompute of the
// scoring (the `byDimension` JSON is rebuilt from scratch each time and would
// otherwise wipe the assessor's words). Composite PK keeps it strictly
// one-narrative-per-dimension-per-engagement so writes are an upsert.
export const scoringNarrativesTable = pgTable(
  "scoring_narratives",
  {
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    narrative: text("narrative").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    updatedByName: text("updated_by_name"),
    updatedByEmail: text("updated_by_email"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.engagementId, t.dimension] }),
  }),
);

export const scoreOverridesTable = pgTable("score_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  engagementId: uuid("engagement_id")
    .notNull()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  dimension: text("dimension").notNull(),
  stage: integer("stage").notNull(),
  score: doublePrecision("score"),
  justification: text("justification").notNull(),
  // Actor attribution so the scoring UI can render
  // "Manually overridden by Jane Smith". Nullable for legacy rows
  // written before authentication was added; reads tolerate NULL.
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  actorName: text("actor_name"),
  actorEmail: text("actor_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliverablesTable = pgTable("deliverables", {
  engagementId: uuid("engagement_id")
    .primaryKey()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  statuses: jsonb("statuses").notNull().default({
    heatmap: "draft",
    gapAnalysis: "draft",
    actionPlan: "draft",
    entryPoint: "draft",
    npv: "draft",
  }),
  heatmap: jsonb("heatmap").notNull().default([]),
  gapAnalysis: jsonb("gap_analysis").notNull().default([]),
  actionPlan: jsonb("action_plan").notNull().default([]),
  entryPoint: jsonb("entry_point"),
  npv: jsonb("npv"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Per-deliverable version history. Every PATCH that touches a deliverable
// snapshots the new state here so an assessor can compare or revert. The
// `finalized` flag marks the snapshot that produced the most recent
// branded export.
export const deliverableVersionsTable = pgTable(
  "deliverable_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    // One of: heatmap | gapAnalysis | actionPlan | entryPoint | npv.
    deliverableKey: text("deliverable_key").notNull(),
    // Monotonically increasing per (engagementId, deliverableKey).
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    authorEmail: text("author_email"),
    finalized: boolean("finalized").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    engKeyIdx: index("deliverable_versions_eng_key_idx").on(
      t.engagementId,
      t.deliverableKey,
    ),
  }),
);

export const exportsTable = pgTable(
  "export_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    signature: text("signature").notNull(),
    files: jsonb("files").notNull().default([]),
    // Email of the assessor who triggered the export. Captured so the
    // Exports tab can attribute "finalized by" without joining
    // activity_events. Nullable for legacy rows created before auth landed.
    finalizerEmail: text("finalizer_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("export_records_engagement_idx").on(t.engagementId) }),
);

export const activityEventsTable = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable so practice-wide events (rubric publish, system actions) can
    // be logged without inventing a synthetic engagement. Engagement-scoped
    // events still set this column.
    engagementId: uuid("engagement_id").references(
      () => engagementsTable.id,
      { onDelete: "cascade" },
    ),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    // Structured before/after payload describing the change. Free-form JSON
    // so each route can capture what's relevant (e.g. score override
    // before/after, connector config diff, finalized deliverable id).
    payload: jsonb("payload").notNull().default({}),
    // Severity flag — `critical` events (token use, score override,
    // deliverable finalize, export download) get visual emphasis in the UI
    // and may be filtered separately for compliance review.
    severity: text("severity", { enum: ["info", "critical"] })
      .notNull()
      .default("info"),
    // Request correlation id (matches the `req.id` value emitted in pino
    // logs and the `x-request-id` response header), so on-call engineers can
    // jump from a timeline entry to the full request trace.
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engIdx: index("activity_events_engagement_idx").on(t.engagementId),
    createdIdx: index("activity_events_created_idx").on(t.createdAt),
    kindIdx: index("activity_events_kind_idx").on(t.kind),
  }),
);
