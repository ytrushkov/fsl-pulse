/**
 * Pure NPV recompute. Same math as the AI deliverable seed in
 * `ai-deliverables.ts`, exposed as a standalone helper so the editor can
 * recompute live as the assessor edits the inputs without re-running AI.
 */

export type LeverKey = "cycle_time" | "rework" | "review" | "onboarding" | "test_quality" | "mttr";

const LEVER_KEYS: LeverKey[] = ["cycle_time", "rework", "review", "onboarding", "test_quality", "mttr"];

export interface NpvInputs {
  fullyLoadedCost: number;
  teamCount: number;
  baselineCycleTimeDays: number;
  aiAcceptanceRate: number;
  reworkRate: number;
  discountRate: number;
  /** Years to project; defaults to 3. */
  horizonYears?: number;
  /** FullStack's all-in hourly rate for estimating implementation cost. Default 250. */
  deliveryHourlyRate?: number;
  /** Which priority tiers to include in investment and savings. Default "all". */
  actionPlanScope?: "p0" | "p0_p1" | "all";
  /** New engineers hired per year. Default 4. */
  newHireCount?: number;
  /** Weeks of ramp time saved per new hire via AI tooling. Default 6. */
  rampWeeksSaved?: number;
  /** Fraction of FLC currently spent on production bug fixes (0–1). Default 0.08. */
  productionDefectRate?: number;
  /** Production incidents per year. Default 12. */
  incidentCount?: number;
  /** Average cost per production incident in $K. Default 15. */
  avgIncidentCostK?: number;
}

export interface NpvScenario {
  npv3yr: number;
  paybackMonths: number;
  irr: number;
  annualSavings: number[];
  /** FullStack delivery cost for in-scope action items. */
  investment: number;
  /** Number of action items in scope. */
  actionItemCount: number;
  /** True when any in-scope item has a manual costEstimate override. */
  hasOverrides: boolean;
  /** Whether savings are driven by lever-tagged items or global assumption formulas. */
  leverSource: "action_plan" | "global_assumptions";
  /** Number of in-scope action items that have a valueLever tag. */
  taggedItemCount: number;
  /** Aggregate expectedImpact per rubric dimension for in-scope items. */
  dimensionImpact: Array<{ dimension: string; totalImpact: number; itemCount: number }>;
}

export interface NpvOutput {
  modelVersion: string;
  inputs: NpvInputs;
  scenarios: { low: NpvScenario; base: NpvScenario; high: NpvScenario };
  leverBreakdown: Array<{ lever: string; savings: number }>;
}

/** Minimal action item shape needed for NPV computation. */
export interface ActionItemSummary {
  id: string;
  priority: "P0" | "P1" | "P2";
  effort: "S" | "M" | "L" | "XL";
  dimension?: string;
  costEstimate?: number | null;
  valueLever?: LeverKey | null;
  expectedImpact?: number | null;
}

const DEFAULTS = {
  fullyLoadedCost: 200_000,
  teamCount: 8,
  baselineCycleTimeDays: 14,
  aiAcceptanceRate: 0.35,
  reworkRate: 0.18,
  discountRate: 0.1,
  horizonYears: 3,
  deliveryHourlyRate: 250,
  actionPlanScope: "all" as const,
  newHireCount: 4,
  rampWeeksSaved: 6,
  productionDefectRate: 0.08,
  incidentCount: 12,
  avgIncidentCostK: 15,
};

/** Hours per effort t-shirt size. */
export const EFFORT_HOURS: Record<string, number> = {
  S: 80,
  M: 240,
  L: 480,
  XL: 640,
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeNpvInputs(raw: Partial<NpvInputs> | null | undefined): NpvInputs {
  const r = raw ?? {};
  return {
    fullyLoadedCost: Math.max(0, num(r.fullyLoadedCost, DEFAULTS.fullyLoadedCost)),
    teamCount: Math.max(1, Math.floor(num(r.teamCount, DEFAULTS.teamCount))),
    baselineCycleTimeDays: Math.max(
      1,
      num(r.baselineCycleTimeDays, DEFAULTS.baselineCycleTimeDays),
    ),
    aiAcceptanceRate: Math.min(1, Math.max(0, num(r.aiAcceptanceRate, DEFAULTS.aiAcceptanceRate))),
    reworkRate: Math.min(1, Math.max(0, num(r.reworkRate, DEFAULTS.reworkRate))),
    discountRate: Math.min(1, Math.max(0, num(r.discountRate, DEFAULTS.discountRate))),
    horizonYears: Math.max(1, Math.min(10, Math.floor(num(r.horizonYears, DEFAULTS.horizonYears)))),
    deliveryHourlyRate: Math.max(0, num(r.deliveryHourlyRate, DEFAULTS.deliveryHourlyRate)),
    actionPlanScope:
      r.actionPlanScope === "p0" || r.actionPlanScope === "p0_p1" || r.actionPlanScope === "all"
        ? r.actionPlanScope
        : "all",
    newHireCount: Math.max(0, Math.floor(num(r.newHireCount, DEFAULTS.newHireCount))),
    rampWeeksSaved: Math.max(0, num(r.rampWeeksSaved, DEFAULTS.rampWeeksSaved)),
    productionDefectRate: Math.min(1, Math.max(0, num(r.productionDefectRate, DEFAULTS.productionDefectRate))),
    incidentCount: Math.max(0, Math.floor(num(r.incidentCount, DEFAULTS.incidentCount))),
    avgIncidentCostK: Math.max(0, num(r.avgIncidentCostK, DEFAULTS.avgIncidentCostK)),
  };
}

/** Resolve a single item's delivery cost — uses explicit override if set, otherwise formula. */
function resolveItemCost(item: ActionItemSummary, rate: number): number {
  if (item.costEstimate != null && Number.isFinite(item.costEstimate)) {
    return item.costEstimate;
  }
  return (EFFORT_HOURS[item.effort] ?? 160) * rate;
}

/** Filter action items by the scope setting. */
function filterByScope(items: ActionItemSummary[], scope: "p0" | "p0_p1" | "all"): ActionItemSummary[] {
  if (scope === "p0") return items.filter((i) => i.priority === "P0");
  if (scope === "p0_p1") return items.filter((i) => i.priority === "P0" || i.priority === "P1");
  return items;
}

/** Compute total investment and metadata for scoped items. */
function computeInvestment(
  items: ActionItemSummary[],
  scope: "p0" | "p0_p1" | "all",
  rate: number,
): { investment: number; count: number; hasOverrides: boolean } {
  const scoped = filterByScope(items, scope);
  let investment = 0;
  let hasOverrides = false;
  for (const item of scoped) {
    if (item.costEstimate != null && Number.isFinite(item.costEstimate)) hasOverrides = true;
    investment += resolveItemCost(item, rate);
  }
  return { investment, count: scoped.length, hasOverrides };
}

/** Aggregate dimension impact for scoped items. */
function computeDimensionImpact(
  items: ActionItemSummary[],
  scope: "p0" | "p0_p1" | "all",
): Array<{ dimension: string; totalImpact: number; itemCount: number }> {
  const scoped = filterByScope(items, scope);
  const map = new Map<string, { totalImpact: number; itemCount: number }>();
  for (const item of scoped) {
    if (!item.dimension) continue;
    const entry = map.get(item.dimension) ?? { totalImpact: 0, itemCount: 0 };
    entry.totalImpact += item.expectedImpact ?? 0;
    entry.itemCount += 1;
    map.set(item.dimension, entry);
  }
  return Array.from(map.entries()).map(([dimension, v]) => ({ dimension, ...v }));
}

export function computeNpv(
  rawInputs: Partial<NpvInputs> | null | undefined,
  actionItems?: ActionItemSummary[],
): NpvOutput {
  const inputs = normalizeNpvInputs(rawInputs);
  const {
    fullyLoadedCost: fl,
    teamCount: tc,
    aiAcceptanceRate: accept,
    reworkRate: rework,
    discountRate: r,
  } = inputs;
  const horizon = inputs.horizonYears ?? 3;
  const rate = inputs.deliveryHourlyRate ?? 250;
  const scope = inputs.actionPlanScope ?? "all";
  const items = actionItems ?? [];

  const newHireCount = inputs.newHireCount ?? DEFAULTS.newHireCount;
  const rampWeeksSaved = inputs.rampWeeksSaved ?? DEFAULTS.rampWeeksSaved;
  const productionDefectRate = inputs.productionDefectRate ?? DEFAULTS.productionDefectRate;
  const incidentCount = inputs.incidentCount ?? DEFAULTS.incidentCount;
  const avgIncidentCost = (inputs.avgIncidentCostK ?? DEFAULTS.avgIncidentCostK) * 1000;

  // Investment computation
  const { investment, count: actionItemCount, hasOverrides } = computeInvestment(items, scope, rate);
  const dimensionImpact = computeDimensionImpact(items, scope);

  // Determine lever savings approach
  const scopedItems = filterByScope(items, scope);
  const taggedItems = scopedItems.filter((i) => !!i.valueLever);
  const leverSource: "action_plan" | "global_assumptions" =
    taggedItems.length > 0 ? "action_plan" : "global_assumptions";

  const leverBase: Record<LeverKey, number> = {
    cycle_time:   fl * tc,
    rework:       fl * tc,
    review:       fl * tc,
    onboarding:   fl * newHireCount,
    test_quality: fl * tc,
    mttr:         incidentCount * avgIncidentCost,
  };

  function leverSavings(multiplier: number): Record<LeverKey, number> {
    if (leverSource === "action_plan") {
      const result = {} as Record<LeverKey, number>;
      for (const lever of LEVER_KEYS) {
        const impact = taggedItems
          .filter((i) => i.valueLever === lever)
          .reduce((s, i) => s + (i.expectedImpact ?? 0), 0);
        result[lever] = leverBase[lever] * impact * multiplier;
      }
      return result;
    }
    return {
      cycle_time:   leverBase.cycle_time * accept * 0.15 * multiplier,
      rework:       leverBase.rework * rework * 0.50 * multiplier,
      review:       leverBase.review * 0.05 * multiplier,
      onboarding:   leverBase.onboarding * (rampWeeksSaved / 52) * multiplier,
      test_quality: leverBase.test_quality * productionDefectRate * 0.40 * multiplier,
      mttr:         leverBase.mttr * 0.30 * multiplier,
    };
  }

  function scenario(multiplier: number): NpvScenario {
    const levers = leverSavings(multiplier);
    const annualBase = LEVER_KEYS.reduce((s, k) => s + levers[k], 0);
    const annualSavings = Array.from(
      { length: horizon },
      (_, y) => annualBase * (1 + 0.1 * y),
    );
    let npv = 0;
    for (let y = 0; y < horizon; y++) {
      npv += (annualSavings[y] ?? 0) / Math.pow(1 + r, y + 1);
    }
    const effectiveInvestment = actionItemCount > 0 ? investment : fl * 0.5;
    npv -= effectiveInvestment;
    const monthly = annualBase / 12;
    const paybackMonths = monthly > 0 ? effectiveInvestment / monthly : 0;
    const irr = effectiveInvestment > 0 ? annualBase / effectiveInvestment : 0;
    return {
      npv3yr: Math.round(npv),
      paybackMonths: Number(paybackMonths.toFixed(1)),
      irr: Number(irr.toFixed(2)),
      annualSavings: annualSavings.map((v) => Math.round(v)),
      investment: Math.round(effectiveInvestment),
      actionItemCount,
      hasOverrides,
      leverSource,
      taggedItemCount: taggedItems.length,
      dimensionImpact,
    };
  }

  const base = scenario(1);
  const baseLevers = leverSavings(1);

  return {
    modelVersion: "1.2.0",
    inputs,
    scenarios: { low: scenario(0.6), base, high: scenario(1.4) },
    leverBreakdown: [
      { lever: "Cycle time reduction",       savings: Math.round(baseLevers.cycle_time) },
      { lever: "Rework reduction",           savings: Math.round(baseLevers.rework) },
      { lever: "Code review acceleration",   savings: Math.round(baseLevers.review) },
      { lever: "Onboarding acceleration",    savings: Math.round(baseLevers.onboarding) },
      { lever: "Test coverage & quality",    savings: Math.round(baseLevers.test_quality) },
      { lever: "Incident resolution (MTTR)", savings: Math.round(baseLevers.mttr) },
    ],
  };
}
