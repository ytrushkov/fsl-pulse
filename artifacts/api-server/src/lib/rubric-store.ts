import { and, desc, eq } from "drizzle-orm";
import { db, rubricVersionsTable } from "@workspace/db";
import {
  DIMENSIONS,
  RUBRIC,
  RUBRIC_VERSION,
  type Dimension,
  type DimensionRubric,
} from "./rubric";
import { logger } from "./logger";

export interface RubricBody {
  dimensions: DimensionRubric[];
  // Optional per-dimension multiplicative weight applied to the overall
  // score average. Defaults to 1.0 each. A future rubric can re-weight
  // (e.g. "double-count governance") without touching dimension math.
  dimensionWeights?: Partial<Record<Dimension, number>>;
}

export interface RubricVersionRow {
  id: string;
  version: string;
  status: "draft" | "published";
  body: RubricBody;
  notes: string;
  createdByEmail: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}

function rowToVersion(r: typeof rubricVersionsTable.$inferSelect): RubricVersionRow {
  return {
    id: r.id,
    version: r.version,
    status: r.status as "draft" | "published",
    body: (r.body as RubricBody) ?? { dimensions: RUBRIC },
    notes: r.notes ?? "",
    createdByEmail: r.createdByEmail ?? null,
    publishedAt: r.publishedAt ?? null,
    createdAt: r.createdAt,
  };
}

/**
 * Idempotently ensure that the shipped v1.0.0 rubric exists as a published
 * row. Called from server boot. Without this, freshly migrated databases
 * have no rubric for the scoring engine to pin against.
 */
export async function ensureSeedRubric(): Promise<void> {
  const existing = await db
    .select()
    .from(rubricVersionsTable)
    .where(
      and(
        eq(rubricVersionsTable.version, RUBRIC_VERSION),
        eq(rubricVersionsTable.status, "published"),
      ),
    );
  if (existing.length > 0) return;
  const body: RubricBody = {
    dimensions: RUBRIC,
    dimensionWeights: Object.fromEntries(DIMENSIONS.map((d) => [d, 1])) as Record<
      Dimension,
      number
    >,
  };
  await db.insert(rubricVersionsTable).values({
    version: RUBRIC_VERSION,
    status: "published",
    body,
    notes: "Initial v1.0.0 shipped with Pulse.",
    publishedAt: new Date(),
  });
  logger.info({ version: RUBRIC_VERSION }, "Seeded initial rubric");
}

export async function listRubricVersions(): Promise<RubricVersionRow[]> {
  const rows = await db
    .select()
    .from(rubricVersionsTable)
    .orderBy(desc(rubricVersionsTable.createdAt));
  return rows.map(rowToVersion);
}

export async function getRubricVersion(id: string): Promise<RubricVersionRow | null> {
  const [row] = await db
    .select()
    .from(rubricVersionsTable)
    .where(eq(rubricVersionsTable.id, id));
  return row ? rowToVersion(row) : null;
}

export async function getLatestPublishedRubric(): Promise<RubricVersionRow> {
  const rows = await db
    .select()
    .from(rubricVersionsTable)
    .where(eq(rubricVersionsTable.status, "published"))
    .orderBy(desc(rubricVersionsTable.publishedAt));
  if (rows.length === 0) {
    // Bootstrap fallback in case ensureSeedRubric somehow lost the race.
    await ensureSeedRubric();
    const retry = await db
      .select()
      .from(rubricVersionsTable)
      .where(eq(rubricVersionsTable.status, "published"))
      .orderBy(desc(rubricVersionsTable.publishedAt));
    if (retry.length === 0) {
      throw new Error("No published rubric available");
    }
    return rowToVersion(retry[0]!);
  }
  return rowToVersion(rows[0]!);
}

/**
 * Resolve the rubric to use for a scoring computation. If `rubricVersionId`
 * is supplied (e.g. preview or upgrade) we load that exact row; otherwise
 * we fall back to the latest published version. Drafts are valid targets
 * for preview but never get pinned to scoringTable by the upgrade path —
 * that's enforced at the route layer.
 */
export async function resolveRubricForScoring(
  rubricVersionId?: string | null,
): Promise<RubricVersionRow> {
  if (rubricVersionId) {
    const r = await getRubricVersion(rubricVersionId);
    if (r) return r;
  }
  return getLatestPublishedRubric();
}

export async function createDraftRubric(input: {
  version: string;
  notes?: string;
  body?: RubricBody;
  cloneFromId?: string;
  createdByEmail?: string;
}): Promise<RubricVersionRow> {
  let body: RubricBody;
  if (input.body) {
    body = input.body;
  } else if (input.cloneFromId) {
    const src = await getRubricVersion(input.cloneFromId);
    if (!src) throw new Error("cloneFromId not found");
    body = src.body;
  } else {
    const latest = await getLatestPublishedRubric();
    body = latest.body;
  }
  const [row] = await db
    .insert(rubricVersionsTable)
    .values({
      version: input.version,
      status: "draft",
      notes: input.notes ?? "",
      body,
      createdByEmail: input.createdByEmail ?? null,
    })
    .returning();
  return rowToVersion(row!);
}

export async function updateDraftRubric(
  id: string,
  patch: { version?: string; notes?: string; body?: RubricBody },
): Promise<RubricVersionRow | null> {
  const existing = await getRubricVersion(id);
  if (!existing) return null;
  if (existing.status === "published") {
    throw new Error("Cannot edit a published rubric");
  }
  const next: Record<string, unknown> = {};
  if (patch.version !== undefined) next.version = patch.version;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.body !== undefined) next.body = patch.body;
  await db
    .update(rubricVersionsTable)
    .set(next)
    .where(eq(rubricVersionsTable.id, id));
  return getRubricVersion(id);
}

export async function publishDraftRubric(id: string): Promise<RubricVersionRow | null> {
  const existing = await getRubricVersion(id);
  if (!existing) return null;
  if (existing.status === "published") {
    // Idempotent: re-publishing a published row is a no-op.
    return existing;
  }
  await db
    .update(rubricVersionsTable)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(rubricVersionsTable.id, id));
  return getRubricVersion(id);
}

export async function deleteDraftRubric(id: string): Promise<boolean> {
  const existing = await getRubricVersion(id);
  if (!existing) return false;
  if (existing.status === "published") {
    throw new Error("Cannot delete a published rubric");
  }
  await db.delete(rubricVersionsTable).where(eq(rubricVersionsTable.id, id));
  return true;
}
