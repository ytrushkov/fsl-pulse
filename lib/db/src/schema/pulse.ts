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
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("connectors_engagement_idx").on(t.engagementId) }),
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
    emailHash: text("email_hash"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("sent"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("artifact_docs_engagement_idx").on(t.engagementId) }),
);

export const scoringTable = pgTable("scoring", {
  engagementId: uuid("engagement_id")
    .primaryKey()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  rubricVersion: text("rubric_version").notNull().default("1.0.0"),
  byDimension: jsonb("by_dimension").notNull().default([]),
  overall: jsonb("overall").notNull().default({}),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scoreOverridesTable = pgTable("score_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  engagementId: uuid("engagement_id")
    .notNull()
    .references(() => engagementsTable.id, { onDelete: "cascade" }),
  dimension: text("dimension").notNull(),
  stage: integer("stage").notNull(),
  score: doublePrecision("score"),
  justification: text("justification").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("export_records_engagement_idx").on(t.engagementId) }),
);

export const activityEventsTable = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagementsTable.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ engIdx: index("activity_events_engagement_idx").on(t.engagementId) }),
);
