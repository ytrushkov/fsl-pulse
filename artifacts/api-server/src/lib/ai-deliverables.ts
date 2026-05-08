import { anthropic } from "@workspace/integrations-anthropic-ai";
import { DIMENSIONS, RUBRIC, STAGE_LABELS, type Dimension } from "./rubric";

interface DimScore {
  dimension: string;
  score: number;
  stage: number;
  confidence: string;
  evidenceIds: string[];
  rationale: string;
}

interface EvidenceLite {
  id: string;
  dimension: string;
  signalType: string;
  stageHint: number | null;
  text: string;
}

interface DraftInput {
  scoring: { byDimension: DimScore[]; overall: { score: number; stage: number; confidence: string } };
  evidence: EvidenceLite[];
  previousNpv: Record<string, unknown> | null;
}

const MODEL = "claude-sonnet-4-6";

function buildHeatmap(byDimension: DimScore[]) {
  return byDimension.map((d) => ({
    dimension: d.dimension,
    currentStage: d.stage,
    targetStage: Math.min(5, d.stage + 1),
    confidence: d.confidence,
  }));
}

function defaultNpv(prev: Record<string, unknown> | null) {
  const inputs = (prev?.inputs as Record<string, unknown> | undefined) ?? {
    fullyLoadedCost: 200000,
    teamCount: 8,
    baselineCycleTimeDays: 14,
    aiAcceptanceRate: 0.35,
    reworkRate: 0.18,
    discountRate: 0.1,
  };
  const fl = Number(inputs.fullyLoadedCost);
  const tc = Number(inputs.teamCount);
  const cycle = Number(inputs.baselineCycleTimeDays);
  const accept = Number(inputs.aiAcceptanceRate);
  const rework = Number(inputs.reworkRate);
  const r = Number(inputs.discountRate);

  function scenario(multiplier: number) {
    const cycleSavings = fl * tc * accept * 0.15 * multiplier;
    const reworkSavings = fl * tc * rework * 0.5 * multiplier;
    const reviewSavings = fl * tc * 0.05 * multiplier;
    const annual = cycleSavings + reworkSavings + reviewSavings;
    const annualSavings = [annual, annual * 1.1, annual * 1.2];
    let npv = 0;
    for (let y = 0; y < 3; y++) {
      npv += annualSavings[y] / Math.pow(1 + r, y + 1);
    }
    const investment = fl * 0.5;
    npv -= investment;
    const monthly = annual / 12;
    const paybackMonths = monthly > 0 ? investment / monthly : 0;
    const irr = annual / investment;
    return {
      npv3yr: Math.round(npv),
      paybackMonths: Number(paybackMonths.toFixed(1)),
      irr: Number(irr.toFixed(2)),
      annualSavings: annualSavings.map((v) => Math.round(v)),
    };
  }
  const base = scenario(1);
  const baseAnnual = base.annualSavings[0];
  return {
    modelVersion: "1.0.0",
    inputs,
    scenarios: { low: scenario(0.6), base, high: scenario(1.4) },
    leverBreakdown: [
      { lever: "Cycle time reduction", savings: Math.round(baseAnnual * 0.45) },
      { lever: "Rework reduction", savings: Math.round(baseAnnual * 0.4) },
      { lever: "Code review acceleration", savings: Math.round(baseAnnual * 0.15) },
    ],
  };
}

function fallbackGapAnalysis(byDimension: DimScore[], evidence: EvidenceLite[]) {
  return byDimension.map((d) => {
    const evList = evidence.filter((e) => e.dimension === d.dimension).slice(0, 5);
    const target = Math.min(5, d.stage + 1);
    return {
      dimension: d.dimension as Dimension,
      currentStage: d.stage,
      targetStage: target,
      narrativeMd: `## ${d.dimension}\n\nCurrent stage: **${d.stage} (${STAGE_LABELS[d.stage]})**. Target: **${target} (${STAGE_LABELS[target]})**.\n\nObserved signals indicate the team operates at stage ${d.stage}. Closing the gap to stage ${target} requires a focused initiative captured in the Action Plan.`,
      gaps: evList.filter((e) => e.signalType === "gap" || e.signalType === "risk").map((e) => e.text),
      evidenceIds: evList.map((e) => e.id),
    };
  });
}

function fallbackActionPlan(byDimension: DimScore[]) {
  return byDimension.flatMap((d, idx) => {
    const target = Math.min(5, d.stage + 1);
    const effort = "M" as const;
    return [
      {
        id: `${d.dimension}-1`,
        initiative: `Stand up ${d.dimension} working group to reach stage ${target}`,
        dimension: d.dimension as Dimension,
        priority: (idx === 0 ? "P0" : idx < 3 ? "P1" : "P2") as "P0" | "P1" | "P2",
        effort,
        impact: "L" as const,
        ownerRole: "Engineering Director",
        successMetric: `${d.dimension} stage advances to ${target} within 90 days`,
        dependencies: [] as string[],
        // costEstimate intentionally omitted: formula-derived items have no stored
        // override so the server always recomputes from effort × deliveryHourlyRate
      },
    ];
  });
}

function fallbackEntryPoint(overallStage: number, evidenceIds: string[]) {
  const stageMap = ["strategy", "design", "build", "ship", "run"] as const;
  const recommendedStage = stageMap[Math.max(0, Math.min(4, overallStage - 1))];
  return {
    recommendedStage,
    hyprAgents: [
      { name: "Hypr Strategy Agent", relevance: "Diagnostic alignment & roadmap" },
      { name: "Hypr Build Agent", relevance: "Codegen & PR review automation" },
    ],
    rationaleMd: `Based on overall stage ${overallStage}, recommended PDLC entry point is **${recommendedStage}**. Begin with the highest-leverage agents that match the team's current maturity.`,
    evidenceIds: evidenceIds.slice(0, 5),
  };
}

export type AiCtx = { requestId?: string };

export async function draftDeliverablesAi(input: DraftInput, ctx: AiCtx = {}) {
  const { scoring, evidence, previousNpv } = input;
  const heatmap = buildHeatmap(scoring.byDimension);

  // Try AI for narratives; fall back if it fails
  let gapAnalysis = fallbackGapAnalysis(scoring.byDimension, evidence);
  let actionPlan = fallbackActionPlan(scoring.byDimension);
  let entryPoint = fallbackEntryPoint(
    scoring.overall.stage,
    evidence.map((e) => e.id),
  );

  try {
    const evidenceCsv = evidence
      .slice(0, 60)
      .map(
        (e) =>
          `[${e.id}] dim=${e.dimension} type=${e.signalType} stageHint=${e.stageHint ?? ""} :: ${e.text.replace(/\n/g, " ").slice(0, 280)}`,
      )
      .join("\n");
    const scoringSummary = scoring.byDimension
      .map((d) => `- ${d.dimension}: stage ${d.stage} (score ${d.score}, confidence ${d.confidence})`)
      .join("\n");
    const rubricSummary = RUBRIC.map(
      (r) =>
        `${r.dimension}: ${r.stages.map((s) => `${s.stage}=${s.summary}`).join(" | ")}`,
    ).join("\n");

    const prompt = `You are FullStack's senior Agentic Maturity assessor. Draft three deliverables based on the scoring and evidence below. Respond ONLY with strict JSON matching this TypeScript shape:

{
  "gapAnalysis": Array<{
    "dimension": "tooling"|"measurement"|"process"|"people"|"governance"|"culture",
    "currentStage": 1|2|3|4|5,
    "targetStage": 1|2|3|4|5,
    "narrativeMd": string,         // 2-3 short paragraphs in markdown
    "gaps": string[],              // 2-4 concise gap statements
    "evidenceIds": string[]        // MUST cite at least 1 evidence id from the evidence list
  }>,
  "actionPlan": Array<{
    "id": string,
    "initiative": string,
    "dimension": "tooling"|"measurement"|"process"|"people"|"governance"|"culture",
    "priority": "P0"|"P1"|"P2",
    "effort": "S"|"M"|"L"|"XL",         // cost = effort × deliveryHourlyRate (server-computed, do NOT include here)
    "impact": "S"|"M"|"L"|"XL",
    "ownerRole": string,
    "successMetric": string,
    "dependencies": string[],
    "valueLever": "cycle_time"|"rework"|"review"|null,
    "expectedImpact": number             // 0-1 fraction; 0.05=Low, 0.10=Medium, 0.20=High
  }>,
  "entryPoint": {
    "recommendedStage": "strategy"|"design"|"build"|"ship"|"run",
    "hyprAgents": Array<{"name": string, "relevance": string}>,
    "rationaleMd": string,
    "evidenceIds": string[]        // MUST cite at least 1 evidence id
  }
}

RUBRIC (5 stages per dimension):
${rubricSummary}

SCORING:
${scoringSummary}
Overall stage: ${scoring.overall.stage}, confidence ${scoring.overall.confidence}

EVIDENCE (id in brackets — cite these exact ids in evidenceIds fields):
${evidenceCsv || "(no evidence yet — produce hypothesis-only narratives and leave evidenceIds empty)"}

Return ONE valid JSON object. Do not wrap in markdown fences. Do not include any commentary.`;

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    const jsonStr = extractJson(raw);
    const parsed = JSON.parse(jsonStr) as Partial<{
      gapAnalysis: typeof gapAnalysis;
      actionPlan: typeof actionPlan;
      entryPoint: typeof entryPoint;
    }>;
    if (parsed.gapAnalysis && Array.isArray(parsed.gapAnalysis))
      gapAnalysis = parsed.gapAnalysis;
    if (parsed.actionPlan && Array.isArray(parsed.actionPlan)) {
      // Strip any formula-derived costEstimate the AI may have included — only
      // explicit manual overrides belong in stored data. Formula cost is always
      // recomputed server-side using the current deliveryHourlyRate.
      actionPlan = parsed.actionPlan.map(
        (item: typeof actionPlan[number] & { costEstimate?: number }) => {
          const { costEstimate: _drop, ...rest } = item as typeof item & { costEstimate?: number };
          void _drop;
          return rest;
        },
      );
    }
    if (parsed.entryPoint) entryPoint = parsed.entryPoint;
  } catch (e) {
    // Keep fallbacks. Tag with requestId so the failure can be correlated to
    // the originating API call in centralized logs.
    console.error(
      `[requestId=${ctx.requestId ?? "n/a"}] AI deliverables draft failed:`,
      e,
    );
  }

  const npv = defaultNpv(previousNpv);
  return { heatmap, gapAnalysis, actionPlan, entryPoint, npv };
}

function extractJson(s: string): string {
  // Strip markdown code fences if present and find the first { ... last }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return candidate;
  return candidate.slice(start, end + 1);
}

export async function suggestInterviewTagsAi(notes: string, ctx: AiCtx = {}) {
  if (!notes || notes.trim().length === 0) {
    return { suggestions: [] };
  }
  try {
    const prompt = `You are an interview analyst for an agentic maturity assessment. Read these interview notes and extract 3-8 evidence tags. Each tag must classify a specific quote/observation into:
- dimension: one of tooling, measurement, process, people, governance, culture
- signalType: one of strength, gap, risk, quote
- stageHint (optional): integer 1-5 mapped to maturity (1=Legacy ... 5=Dark Factory/Agentic Development)
- text: the exact quote or paraphrased observation (≤ 240 chars)
- rationale: one sentence explaining why this signal matters

Respond ONLY with strict JSON: { "suggestions": Array<{text, dimension, signalType, stageHint, rationale}> }. No markdown fences.

Notes:
${notes.slice(0, 6000)}`;

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    const jsonStr = extractJson(raw);
    const parsed = JSON.parse(jsonStr) as {
      suggestions?: Array<{
        text: string;
        dimension: string;
        signalType: string;
        stageHint?: number | null;
        rationale: string;
      }>;
    };
    const valid = (parsed.suggestions ?? []).filter(
      (s) =>
        s.text &&
        DIMENSIONS.includes(s.dimension as Dimension) &&
        ["strength", "gap", "risk", "quote"].includes(s.signalType),
    );
    return { suggestions: valid };
  } catch (e) {
    console.error(
      `[requestId=${ctx.requestId ?? "n/a"}] AI tag suggest failed:`,
      e,
    );
    return { suggestions: [] };
  }
}
