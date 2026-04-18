import type { Dimension } from "./rubric";

export interface SurveyQuestionDef {
  id: string;
  section: string;
  dimension: Dimension | null;
  type: "single_select" | "multi_select" | "likert" | "rank" | "demographic";
  prompt: string;
  options?: string[];
  likertMin?: number;
  likertMax?: number;
  likertMinLabel?: string;
  likertMaxLabel?: string;
  rankCount?: number;
  moduleKey?: "security" | "data" | "platform" | "design";
  conditionalOn?: string;
}

const likert = (
  id: string,
  section: string,
  dimension: Dimension | null,
  prompt: string,
  moduleKey?: SurveyQuestionDef["moduleKey"],
): SurveyQuestionDef => ({
  id,
  section,
  dimension,
  type: "likert",
  prompt,
  likertMin: 1,
  likertMax: 5,
  likertMinLabel: "Strongly disagree",
  likertMaxLabel: "Strongly agree",
  moduleKey,
});

export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestionDef[] = [
  // Demographics (4)
  { id: "d1", section: "About you", dimension: null, type: "demographic", prompt: "Which team do you belong to?" },
  { id: "d2", section: "About you", dimension: null, type: "single_select", prompt: "Your role", options: ["Engineer", "Tech Lead", "Engineering Manager", "Director+", "Product/Design", "Other"] },
  { id: "d3", section: "About you", dimension: null, type: "single_select", prompt: "Years at the company", options: ["<1", "1-2", "3-5", "6-10", "10+"] },
  { id: "d4", section: "About you", dimension: null, type: "single_select", prompt: "Frequency of AI tool use today", options: ["Never", "Monthly", "Weekly", "Daily", "Hourly"] },

  // Tooling (5)
  likert("t1", "Tooling", "tooling", "AI coding tools (Copilot/Cursor/etc.) are reliably available to my team."),
  likert("t2", "Tooling", "tooling", "Our PR review process incorporates AI assistance."),
  likert("t3", "Tooling", "tooling", "Our IDEs are configured for AI-assisted refactors and codegen."),
  likert("t4", "Tooling", "tooling", "We have AI-aware testing tools (test gen, flake triage)."),
  likert("t5", "Tooling", "tooling", "Agentic workflows run inside our CI/CD pipeline."),

  // Measurement (4)
  likert("m1", "Measurement", "measurement", "We track DORA metrics for my team consistently."),
  likert("m2", "Measurement", "measurement", "We measure AI suggestion acceptance rate."),
  likert("m3", "Measurement", "measurement", "We can attribute cycle-time improvements to AI levers."),
  likert("m4", "Measurement", "measurement", "Outcome metrics tied to AI use are visible to leadership."),

  // Process (5)
  likert("p1", "Process", "process", "AI tools are integrated into our planning/design steps."),
  likert("p2", "Process", "process", "AI is used during code authoring on most tasks."),
  likert("p3", "Process", "process", "AI assists with code review and merge gates."),
  likert("p4", "Process", "process", "AI is part of our release / on-call workflow."),
  likert("p5", "Process", "process", "We have documented entry points for AI in our PDLC."),

  // People (4)
  likert("pe1", "People", "people", "I have received structured training on effective AI tool use."),
  likert("pe2", "People", "people", "Our role descriptions reflect AI fluency expectations."),
  likert("pe3", "People", "people", "We have career paths for AI-native engineering roles."),
  likert("pe4", "People", "people", "Hiring criteria include AI / agent supervision skills."),

  // Governance (4)
  likert("g1", "Governance", "governance", "We have a clear, current AI acceptable-use policy."),
  likert("g2", "Governance", "governance", "Models and vendors go through formal evaluation before adoption."),
  likert("g3", "Governance", "governance", "AI-generated code/output is logged and auditable."),
  likert("g4", "Governance", "governance", "Security review covers AI tool integrations."),

  // Culture (4)
  likert("c1", "Culture", "culture", "Leadership actively encourages experimentation with AI."),
  likert("c2", "Culture", "culture", "I feel safe sharing AI failures and learnings."),
  likert("c3", "Culture", "culture", "Teams share AI wins and patterns regularly."),
  likert("c4", "Culture", "culture", "There is healthy skepticism — we don't adopt AI blindly."),

  // Optional modules
  likert("sec1", "Security module", "governance", "We have controls for prompt injection and data exfiltration via AI tools.", "security"),
  likert("sec2", "Security module", "governance", "AI tool usage is covered by our SOC2/ISO controls.", "security"),
  likert("data1", "Data module", "measurement", "We govern training and RAG data sources rigorously.", "data"),
  likert("data2", "Data module", "tooling", "We have evals tied to data quality for AI-driven features.", "data"),
  likert("plat1", "Platform module", "tooling", "We have an internal AI platform / gateway for model access.", "platform"),
  likert("plat2", "Platform module", "process", "Our platform team supports AI-native developer workflows.", "platform"),
  likert("des1", "Design module", "process", "Designers use AI in research and ideation.", "design"),
  likert("des2", "Design module", "tooling", "Designers use AI in production handoff.", "design"),
];
