import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  evidenceTable,
  scoringTable,
  scoreOverridesTable,
  surveyResponsesTable,
  connectorsTable,
  connectorRunsTable,
} from "@workspace/db";
import { DIMENSIONS, type Dimension } from "./rubric";
import { DEFAULT_SURVEY_QUESTIONS } from "./survey-template";
import { resolveRubricForScoring, type RubricVersionRow } from "./rubric-store";

const ANONYMITY_FLOOR = 5;

interface DimensionAggregate {
  dimension: Dimension;
  rawScore: number;
  stage: number;
  confidence: "low" | "medium" | "high";
  evidenceIds: string[];
  rationale: string;
  signalsBySource: { system: number; survey: number; interview: number; artifact: number };
  overrideJustification: string | null;
}

const SIGNAL_WEIGHTS = {
  system: 1.5,
  artifact: 1.2,
  interview: 1.0,
  survey: 0.8,
} as const;

const SIGNAL_TYPE_WEIGHTS: Record<string, number> = {
  strength: 1.0,
  gap: -0.7,
  risk: -1.0,
  quote: 0.3,
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

async function aggregateSurveyByDimension(
  engagementId: string,
): Promise<Record<Dimension, { mean: number; count: number }>> {
  const responses = await db
    .select()
    .from(surveyResponsesTable)
    .where(eq(surveyResponsesTable.engagementId, engagementId));
  const totals: Record<string, { sum: number; n: number }> = {};
  for (const dim of DIMENSIONS) totals[dim] = { sum: 0, n: 0 };
  // suppress per-team groups <5 from individual signal weighting? We aggregate at engagement level for scoring.
  if (responses.length < ANONYMITY_FLOOR) {
    return Object.fromEntries(DIMENSIONS.map((d) => [d, { mean: 0, count: 0 }])) as Record<
      Dimension,
      { mean: number; count: number }
    >;
  }
  const qById = new Map(DEFAULT_SURVEY_QUESTIONS.map((q) => [q.id, q]));
  for (const r of responses) {
    const answers = r.answers as Array<{ questionId: string; value: unknown }>;
    for (const a of answers) {
      const q = qById.get(a.questionId);
      if (!q || !q.dimension || q.type !== "likert") continue;
      const v = typeof a.value === "number" ? a.value : Number(a.value);
      if (!Number.isFinite(v)) continue;
      const t = totals[q.dimension];
      t.sum += v;
      t.n += 1;
    }
  }
  const out: Record<string, { mean: number; count: number }> = {};
  for (const dim of DIMENSIONS) {
    const t = totals[dim];
    out[dim] = { mean: t.n > 0 ? t.sum / t.n : 0, count: t.n };
  }
  return out as Record<Dimension, { mean: number; count: number }>;
}

async function getSystemSignals(engagementId: string): Promise<Record<Dimension, number>> {
  const out: Record<string, number> = {};
  for (const d of DIMENSIONS) out[d] = 0;
  const connectors = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.engagementId, engagementId));
  if (connectors.length === 0) return out as Record<Dimension, number>;
  const collected = connectors.filter((c) => c.status === "collected").length;
  const ratio = collected / connectors.length;
  // Successful connector data lifts tooling and measurement modestly
  out.tooling = ratio * 0.6;
  out.measurement = ratio * 0.6;
  // CICD specifically lifts process
  if (connectors.some((c) => c.kind === "cicd" && c.status === "collected")) out.process = 0.4;
  // ai_tooling lifts tooling more
  if (connectors.some((c) => c.kind === "ai_tooling" && c.status === "collected")) out.tooling += 0.4;

  // Use connector run summaries to add finer signal — scoped to this engagement's connectors only
  const connectorIds = connectors.map((c) => c.id);
  const runs = connectorIds.length
    ? await db
        .select()
        .from(connectorRunsTable)
        .where(
          and(
            inArray(connectorRunsTable.connectorId, connectorIds),
            eq(connectorRunsTable.status, "success"),
          ),
        )
    : [];
  for (const r of runs) {
    const summary = r.summary as Record<string, unknown>;
    if (summary && typeof summary === "object") {
      // boost based on collected evidence size
      const recs = Number(summary.recordsCollected) || 0;
      if (recs > 50) out.measurement += 0.1;
    }
  }
  return out as Record<Dimension, number>;
}

/**
 * Compute scoring for an engagement.
 *
 * @param engagementId - the engagement
 * @param opts.rubricVersionId - explicit rubric to score against. When
 *   omitted the latest published rubric is used. Drafts are valid here
 *   for preview flows; the route layer is responsible for refusing to
 *   *persist* a draft pin.
 * @param opts.persist - when false, the result is returned but not written
 *   to scoringTable. Used by the "preview against draft" feature so an
 *   assessor can see deltas without overwriting the live scoring.
 */
export async function computeEngagementScoring(
  engagementId: string,
  opts: { rubricVersionId?: string | null; persist?: boolean } = {},
) {
  const persist = opts.persist !== false;
  const rubric = await resolveRubricForScoring(opts.rubricVersionId);
  return computeWithRubric(engagementId, rubric, persist);
}

async function computeWithRubric(
  engagementId: string,
  rubric: RubricVersionRow,
  persist: boolean,
) {
  const evidenceRows = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.engagementId, engagementId));
  const overrides = await db
    .select()
    .from(scoreOverridesTable)
    .where(eq(scoreOverridesTable.engagementId, engagementId));

  const surveyMeans = await aggregateSurveyByDimension(engagementId);
  const systemSignals = await getSystemSignals(engagementId);

  const aggregates: DimensionAggregate[] = [];

  for (const dim of DIMENSIONS) {
    const dimEvidence = evidenceRows.filter((e) => e.dimension === dim);
    const evidenceIds = dimEvidence.map((e) => e.id);

    // Start from survey mean (1-5)
    const surveyAvg = surveyMeans[dim].mean; // 0 if no responses
    let baseScore = surveyAvg > 0 ? surveyAvg : 2.5; // neutral default

    // Evidence adjustment: weighted sum normalized
    let evidenceDelta = 0;
    let evidenceWeight = 0;
    const signalsBySource = { system: 0, survey: 0, interview: 0, artifact: 0 };
    for (const e of dimEvidence) {
      const sourceW =
        SIGNAL_WEIGHTS[(e.sourceType as keyof typeof SIGNAL_WEIGHTS) ?? "interview"] ?? 1.0;
      const typeW = SIGNAL_TYPE_WEIGHTS[e.signalType] ?? 0;
      const stageHint = e.stageHint != null ? e.stageHint : null;
      // delta toward stageHint if provided
      if (stageHint != null) {
        evidenceDelta += (stageHint - baseScore) * sourceW * Math.abs(typeW) * 0.3;
        evidenceWeight += sourceW;
      } else {
        evidenceDelta += typeW * sourceW * 0.4;
        evidenceWeight += sourceW;
      }
      const k = (e.sourceType as keyof typeof signalsBySource) || "interview";
      if (k in signalsBySource) signalsBySource[k] += 1;
    }

    // System adjustment
    const sysAdj = systemSignals[dim] || 0;

    let combined = baseScore + evidenceDelta + sysAdj;
    combined = clamp(combined, 1, 5);

    // Override?
    const override = overrides
      .filter((o) => o.dimension === dim)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
    let stage = Math.round(combined);
    let overrideJustification: string | null = null;
    if (override) {
      stage = clamp(Math.round(override.stage), 1, 5);
      combined = clamp(override.score ?? override.stage, 1, 5);
      overrideJustification = override.justification;
    }

    // Confidence based on evidence count + survey count
    const totalSignals =
      dimEvidence.length + (surveyMeans[dim].count > 0 ? 1 : 0) + (sysAdj > 0 ? 1 : 0);
    let confidence: "low" | "medium" | "high" = "low";
    if (totalSignals >= 6) confidence = "high";
    else if (totalSignals >= 3) confidence = "medium";

    const rationale = override
      ? `Override applied: stage ${stage}. Justification: ${override.justification}`
      : `Survey mean ${surveyAvg.toFixed(2)} | evidence ${dimEvidence.length} signals (Δ ${evidenceDelta.toFixed(
          2,
        )}) | system Δ ${sysAdj.toFixed(2)} → ${combined.toFixed(2)} (stage ${stage}).`;

    aggregates.push({
      dimension: dim,
      rawScore: combined,
      stage,
      confidence,
      evidenceIds,
      rationale,
      signalsBySource,
      overrideJustification,
    });
  }

  // Apply per-dimension weights from the rubric body. Default weight is 1
  // for each dimension when the rubric omits the map. We compute a
  // weighted average so a rubric version that re-balances the practice
  // (e.g. doubles governance) actually shifts the headline number.
  const weights = rubric.body.dimensionWeights ?? {};
  // Clamp weights to >= 0 so a hostile or fat-fingered negative weight can't
  // produce a nonsensical (e.g. negative) maturity score. NaN/missing
  // entries fall back to 1.
  const wPairs = aggregates.map((a) => {
    const raw = weights[a.dimension];
    const w = Number.isFinite(raw) ? Math.max(0, Number(raw)) : 1;
    return { score: a.rawScore, w };
  });
  const wSum = wPairs.reduce((s, p) => s + p.w, 0) || aggregates.length;
  const overallScore =
    wPairs.reduce((s, p) => s + p.score * p.w, 0) / wSum;
  const overallStage = Math.round(overallScore);
  const overallConfidence: "low" | "medium" | "high" = aggregates.every(
    (a) => a.confidence === "high",
  )
    ? "high"
    : aggregates.some((a) => a.confidence === "low")
      ? "low"
      : "medium";

  const result = {
    engagementId,
    rubricVersion: rubric.version,
    rubricVersionId: rubric.id,
    rubricStatus: rubric.status,
    byDimension: aggregates.map((a) => ({
      dimension: a.dimension,
      score: Number(a.rawScore.toFixed(2)),
      stage: a.stage,
      confidence: a.confidence,
      evidenceIds: a.evidenceIds,
      rationale: a.rationale,
      overrideJustification: a.overrideJustification,
      signalsBySource: a.signalsBySource,
    })),
    overall: {
      score: Number(overallScore.toFixed(2)),
      stage: overallStage,
      confidence: overallConfidence,
    },
    computedAt: new Date().toISOString(),
  };

  if (!persist) return result;

  // Upsert
  const existing = await db
    .select()
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, engagementId));
  if (existing.length === 0) {
    await db.insert(scoringTable).values({
      engagementId,
      rubricVersion: result.rubricVersion,
      rubricVersionId: result.rubricVersionId,
      byDimension: result.byDimension,
      overall: result.overall,
      computedAt: new Date(),
    });
  } else {
    await db
      .update(scoringTable)
      .set({
        rubricVersion: result.rubricVersion,
        rubricVersionId: result.rubricVersionId,
        byDimension: result.byDimension,
        overall: result.overall,
        computedAt: new Date(),
      })
      .where(eq(scoringTable.engagementId, engagementId));
  }

  return result;
}
