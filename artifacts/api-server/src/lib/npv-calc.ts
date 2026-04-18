/**
 * Pure NPV recompute. Same math as the AI deliverable seed in
 * `ai-deliverables.ts`, exposed as a standalone helper so the editor can
 * recompute live as the assessor edits the inputs without re-running AI.
 */

export interface NpvInputs {
  fullyLoadedCost: number;
  teamCount: number;
  baselineCycleTimeDays: number;
  aiAcceptanceRate: number;
  reworkRate: number;
  discountRate: number;
  /** Years to project; defaults to 3. */
  horizonYears?: number;
}

export interface NpvScenario {
  npv3yr: number;
  paybackMonths: number;
  irr: number;
  annualSavings: number[];
}

export interface NpvOutput {
  modelVersion: string;
  inputs: NpvInputs;
  scenarios: { low: NpvScenario; base: NpvScenario; high: NpvScenario };
  leverBreakdown: Array<{ lever: string; savings: number }>;
}

const DEFAULTS: NpvInputs = {
  fullyLoadedCost: 200_000,
  teamCount: 8,
  baselineCycleTimeDays: 14,
  aiAcceptanceRate: 0.35,
  reworkRate: 0.18,
  discountRate: 0.1,
  horizonYears: 3,
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
    horizonYears: Math.max(1, Math.min(10, Math.floor(num(r.horizonYears, DEFAULTS.horizonYears!)))),
  };
}

export function computeNpv(rawInputs: Partial<NpvInputs> | null | undefined): NpvOutput {
  const inputs = normalizeNpvInputs(rawInputs);
  const { fullyLoadedCost: fl, teamCount: tc, aiAcceptanceRate: accept, reworkRate: rework, discountRate: r } = inputs;
  const horizon = inputs.horizonYears ?? 3;

  function scenario(multiplier: number): NpvScenario {
    const cycleSavings = fl * tc * accept * 0.15 * multiplier;
    const reworkSavings = fl * tc * rework * 0.5 * multiplier;
    const reviewSavings = fl * tc * 0.05 * multiplier;
    const annualBase = cycleSavings + reworkSavings + reviewSavings;
    const annualSavings = Array.from(
      { length: horizon },
      (_, y) => annualBase * (1 + 0.1 * y),
    );
    let npv = 0;
    for (let y = 0; y < horizon; y++) {
      npv += (annualSavings[y] ?? 0) / Math.pow(1 + r, y + 1);
    }
    const investment = fl * 0.5;
    npv -= investment;
    const monthly = annualBase / 12;
    const paybackMonths = monthly > 0 ? investment / monthly : 0;
    const irr = investment > 0 ? annualBase / investment : 0;
    return {
      npv3yr: Math.round(npv),
      paybackMonths: Number(paybackMonths.toFixed(1)),
      irr: Number(irr.toFixed(2)),
      annualSavings: annualSavings.map((v) => Math.round(v)),
    };
  }

  const base = scenario(1);
  const baseAnnual = base.annualSavings[0] ?? 0;

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
