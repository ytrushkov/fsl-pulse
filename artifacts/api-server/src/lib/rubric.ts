export const RUBRIC_VERSION = "1.0.0";

export const DIMENSIONS = [
  "tooling",
  "measurement",
  "process",
  "people",
  "governance",
  "culture",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export const STAGE_LABELS: Record<number, string> = {
  1: "Legacy",
  2: "AI-Assisted",
  3: "AI-Enabled",
  4: "AI-Native",
  5: "Dark Factory / Agentic Development",
};

export interface StageDescriptor {
  stage: number;
  summary: string;
  indicators: string[];
}

export interface DimensionRubric {
  dimension: Dimension;
  description: string;
  stages: StageDescriptor[];
}

export const RUBRIC: DimensionRubric[] = [
  {
    dimension: "tooling",
    description:
      "AI-augmented developer tooling adoption: editors, code-gen, code review, agentic IDEs.",
    stages: [
      { stage: 1, summary: "Manual tooling, no AI assistance", indicators: ["No copilot/codegen", "Code review fully manual"] },
      { stage: 2, summary: "Copilot-class autocomplete adopted by some teams", indicators: ["Copilot/Codeium present", "Inconsistent adoption"] },
      { stage: 3, summary: "AI-assisted IDE & PR review across the org", indicators: ["Sourcegraph Cody / Copilot Enterprise org-wide", "AI PR review enabled"] },
      { stage: 4, summary: "Agentic workflows running in CI and dev loop", indicators: ["Cursor/Devin in PR cycle", "Codegen agents triaging issues"] },
      { stage: 5, summary: "Autonomous engineering agents shipping code with human oversight", indicators: ["Agent fleets", "Human-in-the-loop only at boundaries"] },
    ],
  },
  {
    dimension: "measurement",
    description: "Engineering metrics, SPACE/DORA, AI usage telemetry.",
    stages: [
      { stage: 1, summary: "No reliable engineering metrics", indicators: ["No DORA", "No usage telemetry"] },
      { stage: 2, summary: "DORA reported quarterly, no AI metrics", indicators: ["Lead time tracked", "No AI acceptance rate"] },
      { stage: 3, summary: "DORA + AI acceptance/usage tracked per team", indicators: ["AI suggestion acceptance rate", "Usage by repo"] },
      { stage: 4, summary: "Outcome metrics (cycle time delta, rework) attributed to AI levers", indicators: ["Lever-level attribution", "AI ROI dashboards"] },
      { stage: 5, summary: "Continuous closed-loop measurement; agents tune their own usage", indicators: ["Self-tuning agents", "Auto-rebalanced AI spend"] },
    ],
  },
  {
    dimension: "process",
    description: "PDLC: planning, design, build, ship, run with AI integration points.",
    stages: [
      { stage: 1, summary: "Traditional PDLC, no AI integration", indicators: ["No AI in planning", "Manual test gen"] },
      { stage: 2, summary: "AI inserted opportunistically at one stage", indicators: ["AI for unit tests", "AI in code review only"] },
      { stage: 3, summary: "AI integrated across multiple PDLC stages", indicators: ["AI in design, build, test", "Defined entry points"] },
      { stage: 4, summary: "AI-native PDLC with measured handoffs", indicators: ["Agent-orchestrated stages", "Documented agent boundaries"] },
      { stage: 5, summary: "Continuous agentic delivery; humans steer, agents execute", indicators: ["Agent fleets across PDLC", "Continuous delivery via agents"] },
    ],
  },
  {
    dimension: "people",
    description: "Skills, role evolution, training, AI fluency across the org.",
    stages: [
      { stage: 1, summary: "No AI training, no role change", indicators: ["No upskilling program", "Roles unchanged"] },
      { stage: 2, summary: "Ad-hoc AI training, voluntary", indicators: ["Brown bags", "Optional courses"] },
      { stage: 3, summary: "Structured AI fluency program; role descriptions updated", indicators: ["Mandatory curriculum", "Role rubrics include AI"] },
      { stage: 4, summary: "AI-native roles (agent supervisors, prompt engineers) staffed", indicators: ["New role definitions", "Career ladder for AI roles"] },
      { stage: 5, summary: "Workforce reshaped around agent supervision and design", indicators: ["Org chart redesigned", "Headcount mix shifted"] },
    ],
  },
  {
    dimension: "governance",
    description: "AI policy, security, compliance, evals, model risk management.",
    stages: [
      { stage: 1, summary: "No AI policy", indicators: ["Shadow AI use", "No vendor review"] },
      { stage: 2, summary: "Acceptable-use policy in place", indicators: ["Approved tools list", "Basic DLP"] },
      { stage: 3, summary: "Model & vendor governance with evals", indicators: ["Model registry", "Eval gates"] },
      { stage: 4, summary: "Continuous evals, auditable agent traces", indicators: ["Online evals", "Observability per agent"] },
      { stage: 5, summary: "Closed-loop governance for autonomous systems", indicators: ["Policy enforcement at runtime", "Auto-remediation"] },
    ],
  },
  {
    dimension: "culture",
    description: "Trust, experimentation, psychological safety around AI use.",
    stages: [
      { stage: 1, summary: "Skepticism / fear; AI use discouraged", indicators: ["Bans on tools", "Fear of replacement"] },
      { stage: 2, summary: "Pockets of experimentation", indicators: ["Champions", "Isolated wins"] },
      { stage: 3, summary: "Org-wide experimentation, share-outs", indicators: ["Demo days", "Internal community"] },
      { stage: 4, summary: "Default-to-AI culture with healthy skepticism", indicators: ["AI-first proposals", "Eval-driven adoption"] },
      { stage: 5, summary: "Agent-native culture; humans focus on leverage", indicators: ["Agent supervision the norm", "New rituals around fleets"] },
    ],
  },
];
