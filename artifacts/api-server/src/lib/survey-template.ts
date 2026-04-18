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
  minLabel: string,
  maxLabel: string,
  moduleKey?: SurveyQuestionDef["moduleKey"],
  conditionalOn?: string,
): SurveyQuestionDef => ({
  id,
  section,
  dimension,
  type: "likert",
  prompt,
  likertMin: 1,
  likertMax: 5,
  likertMinLabel: minLabel,
  likertMaxLabel: maxLabel,
  moduleKey,
  conditionalOn,
});

/**
 * v1 Survey Template — verbatim from the PRD.
 * 30 core questions across 7 sections (Demographics not scored) + 4 optional modules of 3 questions each.
 */
export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestionDef[] = [
  // ────────────────────────────────────────────────────────────────────────────
  // Section 0 — Demographics (4, not scored — used for team-level aggregation)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "q1",
    section: "Demographics",
    dimension: null,
    type: "demographic",
    prompt: "Which team are you on?",
  },
  {
    id: "q2",
    section: "Demographics",
    dimension: null,
    type: "single_select",
    prompt: "What is your role?",
    options: [
      "IC Engineer",
      "Senior or Staff Engineer",
      "Tech Lead",
      "Engineering Manager",
      "Architect",
      "Other",
    ],
  },
  {
    id: "q3",
    section: "Demographics",
    dimension: null,
    type: "single_select",
    prompt: "How long have you been at this company?",
    options: ["<6 months", "6–12 months", "1–3 years", "3+ years"],
  },
  {
    id: "q4",
    section: "Demographics",
    dimension: null,
    type: "single_select",
    prompt: "What best describes your primary work?",
    options: [
      "Backend",
      "Frontend",
      "Full-stack",
      "Mobile",
      "Data/ML",
      "DevOps/Platform",
      "QA/SDET",
      "Other",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Section 1 — Tooling (6)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "q5",
    section: "Tooling",
    dimension: "tooling",
    type: "multi_select",
    prompt: "Which AI coding tools do you use at least weekly?",
    options: [
      "GitHub Copilot",
      "Cursor",
      "Claude Code",
      "Windsurf",
      "Amazon Q",
      "ChatGPT",
      "Gemini",
      "Internal tool",
      "None",
      "Other",
    ],
  },
  {
    id: "q6",
    section: "Tooling",
    dimension: "tooling",
    type: "single_select",
    prompt: "How did you start using AI coding tools?",
    options: [
      "Company provided and mandated",
      "Company provided, optional",
      "I set it up myself",
      "I don't use any",
    ],
  },
  {
    id: "q7",
    section: "Tooling",
    dimension: "tooling",
    type: "single_select",
    prompt:
      "What percentage of your code is AI-assisted (generated or substantially edited by AI)?",
    options: ["0%", "1–10%", "11–25%", "26–50%", "51–75%", "76%+"],
  },
  likert(
    "q8",
    "Tooling",
    "tooling",
    "How often do you accept AI-generated suggestions without significant edits?",
    "Never",
    "Almost always",
  ),
  {
    id: "q9",
    section: "Tooling",
    dimension: "tooling",
    type: "multi_select",
    prompt: "In which parts of your workflow do AI tools save you the most time?",
    options: [
      "Writing new code",
      "Writing tests",
      "Code review",
      "Debugging",
      "Documentation",
      "Refactoring",
      "Architecture/design",
      "CI/CD configuration",
      "None — no meaningful time savings",
    ],
  },
  {
    id: "q10",
    section: "Tooling",
    dimension: "tooling",
    type: "single_select",
    prompt:
      "Are any of your team's workflows fully automated end-to-end by AI agents (e.g., auto-generated PRs, autonomous test suites, self-healing pipelines)?",
    options: [
      "Yes, multiple workflows",
      "Yes, one or two",
      "Experimenting",
      "No",
      "Don't know",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Section 2 — Measurement (4)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "q11",
    section: "Measurement",
    dimension: "measurement",
    type: "single_select",
    prompt: "Does your team track developer productivity metrics today?",
    options: [
      "Yes, and I see the data regularly",
      "Yes, but I rarely see results",
      "I think so, but I'm not sure",
      "No",
      "Don't know",
    ],
  },
  {
    id: "q12",
    section: "Measurement",
    dimension: "measurement",
    type: "multi_select",
    prompt: "Which metrics does your team use?",
    options: [
      "Deployment frequency",
      "Lead time for changes",
      "Change failure rate",
      "MTTR",
      "Cycle time",
      "Velocity / story points",
      "Developer experience surveys",
      "Code review turnaround",
      "None that I'm aware of",
      "Other",
    ],
  },
  likert(
    "q13",
    "Measurement",
    "measurement",
    "How useful are the productivity metrics you see in improving your day-to-day work?",
    "Not useful at all",
    "Extremely useful",
    undefined,
    "q11", // shown only if Q11 ≠ "No" or "Don't know"
  ),
  likert(
    "q14",
    "Measurement",
    "measurement",
    "How comfortable are you that productivity metrics are used fairly (not punitively) at your company?",
    "Very uncomfortable",
    "Very comfortable",
  ),

  // ────────────────────────────────────────────────────────────────────────────
  // Section 3 — Process (6)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "q15",
    section: "Process",
    dimension: "process",
    type: "rank",
    prompt: "Where in your delivery process does work get stuck most often? (rank top 3)",
    rankCount: 3,
    options: [
      "Requirements / spec",
      "Design",
      "Coding",
      "Code review",
      "Testing",
      "Deployment",
      "Incident response",
      "None — work flows smoothly",
    ],
  },
  likert(
    "q16",
    "Process",
    "process",
    "How well-defined are your team's engineering standards (coding conventions, PR templates, architecture decision records)?",
    "No standards",
    "Comprehensive and enforced",
  ),
  likert(
    "q17",
    "Process",
    "process",
    "When you pick up a new task, how often do you have all the context you need to start without chasing people?",
    "Rarely",
    "Almost always",
  ),
  {
    id: "q18",
    section: "Process",
    dimension: "process",
    type: "single_select",
    prompt: "How frequently does your team deploy to a QA/UAT environment?",
    options: [
      "Multiple times per day",
      "Daily",
      "A few times per week",
      "Weekly",
      "Biweekly or less",
      "We don't have a pre-production environment",
      "I don't know",
    ],
  },
  {
    id: "q19",
    section: "Process",
    dimension: "process",
    type: "single_select",
    prompt: "How frequently does your team ship to production?",
    options: [
      "Multiple times per day",
      "Daily",
      "A few times per week",
      "Weekly",
      "Biweekly",
      "Monthly",
      "Quarterly or less",
      "I don't know",
    ],
  },
  likert(
    "q20",
    "Process",
    "process",
    "How much rework (fixing things that should have been caught earlier) does your team do?",
    "Almost none",
    "A significant amount",
  ),

  // ────────────────────────────────────────────────────────────────────────────
  // Section 4 — People (4)
  // ────────────────────────────────────────────────────────────────────────────
  likert(
    "q21",
    "People",
    "people",
    "How confident are you in using AI tools effectively in your daily engineering work?",
    "Not confident at all",
    "Very confident",
  ),
  {
    id: "q22",
    section: "People",
    dimension: "people",
    type: "single_select",
    prompt: "Has your company provided training or guidance on using AI in engineering?",
    options: [
      "Yes, structured program",
      "Yes, informal guidance",
      "No, but I'd want it",
      "No, and I don't feel I need it",
    ],
  },
  likert(
    "q23",
    "People",
    "people",
    "How often do you and your teammates share AI tips, prompts, or workflows with each other?",
    "Never",
    "Daily",
  ),
  {
    id: "q24",
    section: "People",
    dimension: "people",
    type: "multi_select",
    prompt:
      "If AI tools handle more routine coding, which skills do you think become most important for your role?",
    options: [
      "System design / architecture",
      "Prompt engineering",
      "Code review / quality judgment",
      "Product thinking",
      "Testing strategy",
      "Security awareness",
      "Communication",
      "I'm not sure",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Section 5 — Governance (3)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "q25",
    section: "Governance",
    dimension: "governance",
    type: "single_select",
    prompt:
      "Does your organization have clear policies on when and how AI-generated code can be used?",
    options: [
      "Yes, well-documented",
      "Yes, but vague",
      "No formal policy",
      "I don't know",
    ],
  },
  {
    id: "q26",
    section: "Governance",
    dimension: "governance",
    type: "single_select",
    prompt: "How is AI-generated code reviewed before it reaches production?",
    options: [
      "Same review process as human code",
      "Extra scrutiny for AI code",
      "No special process",
      "We don't track which code is AI-generated",
    ],
  },
  likert(
    "q27",
    "Governance",
    "governance",
    "How concerned are you about security, IP, or quality risks from AI-generated code?",
    "Not concerned at all",
    "Very concerned",
  ),

  // ────────────────────────────────────────────────────────────────────────────
  // Section 6 — Culture (3)
  // ────────────────────────────────────────────────────────────────────────────
  likert(
    "q28",
    "Culture",
    "culture",
    "How supportive is your leadership of adopting AI in engineering workflows?",
    "Not supportive",
    "Strongly supportive",
  ),
  {
    id: "q29",
    section: "Culture",
    dimension: "culture",
    type: "single_select",
    prompt: "How would you describe your team's attitude toward AI tools?",
    options: [
      "Enthusiastic — we actively experiment",
      "Cautiously optimistic",
      "Neutral — we use what's provided",
      "Skeptical — most people don't see the value",
      "Resistant — people actively avoid AI tools",
    ],
  },
  likert(
    "q30",
    "Culture",
    "culture",
    "Do you feel safe experimenting with AI tools at work, even if an experiment fails or produces a bad result?",
    "Not at all safe",
    "Completely safe",
  ),

  // ────────────────────────────────────────────────────────────────────────────
  // Optional Module A — Security (3)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "a1",
    section: "Module — Security",
    dimension: "governance",
    type: "single_select",
    prompt:
      "How often does AI-generated code in your team go through a security-focused review (SAST, DAST, manual security review)?",
    options: ["Always", "Usually", "Sometimes", "Rarely", "Never", "Don't know"],
    moduleKey: "security",
  },
  {
    id: "a2",
    section: "Module — Security",
    dimension: "governance",
    type: "single_select",
    prompt:
      "Has your team experienced a security issue (vulnerability, secret leak, dependency risk) traced to AI-generated code?",
    options: ["Yes", "No", "Don't know"],
    moduleKey: "security",
  },
  likert(
    "a3",
    "Module — Security",
    "governance",
    "How confident are you that your current security tooling catches risks specific to AI-generated code?",
    "Not confident at all",
    "Very confident",
    "security",
  ),

  // ────────────────────────────────────────────────────────────────────────────
  // Optional Module B — Data & Analytics (3)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "b1",
    section: "Module — Data & Analytics",
    dimension: "measurement",
    type: "single_select",
    prompt:
      "Does your team use AI/ML for data pipelines, analytics, or business intelligence (beyond coding tools)?",
    options: ["Yes, in production", "Experimenting", "No", "Not applicable"],
    moduleKey: "data",
  },
  likert(
    "b2",
    "Module — Data & Analytics",
    "measurement",
    "How accessible is production data for engineers building AI features?",
    "Very restricted",
    "Self-serve access with guardrails",
    "data",
  ),
  {
    id: "b3",
    section: "Module — Data & Analytics",
    dimension: "governance",
    type: "single_select",
    prompt:
      "Does your organization have a data governance framework that covers AI model training and inference data?",
    options: ["Yes", "Partially", "No", "Don't know"],
    moduleKey: "data",
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Optional Module C — Platform Engineering (3)
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "c1",
    section: "Module — Platform Engineering",
    dimension: "tooling",
    type: "single_select",
    prompt:
      "Does your organization have an internal developer platform (IDP) or golden paths for common workflows?",
    options: ["Yes, mature", "Yes, early stage", "No, but planned", "No"],
    moduleKey: "platform",
  },
  likert(
    "c2",
    "Module — Platform Engineering",
    "tooling",
    "How much of your CI/CD pipeline is self-service (you can configure without waiting on another team)?",
    "None",
    "Fully self-service",
    "platform",
  ),
  {
    id: "c3",
    section: "Module — Platform Engineering",
    dimension: "tooling",
    type: "single_select",
    prompt:
      "Are AI tools integrated into your platform (e.g., AI-assisted incident triage, auto-generated runbooks, intelligent deployment gates)?",
    options: ["Yes, multiple integrations", "One or two", "No", "Don't know"],
    moduleKey: "platform",
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Optional Module D — Product Design (3)
  // ────────────────────────────────────────────────────────────────────────────
  likert(
    "d1",
    "Module — Product Design",
    "process",
    "How well do design specs and requirements translate into implementable work by the time engineering picks them up?",
    "Poorly",
    "Excellently",
    "design",
  ),
  {
    id: "d2",
    section: "Module — Product Design",
    dimension: "process",
    type: "single_select",
    prompt:
      "Are AI tools used in your design-to-code handover (e.g., design-to-component generation, spec-to-ticket automation)?",
    options: ["Yes", "Experimenting", "No", "Not applicable"],
    moduleKey: "design",
  },
  likert(
    "d3",
    "Module — Product Design",
    "culture",
    "How closely do product, design, and engineering collaborate on AI feature decisions?",
    "Siloed",
    "Deeply integrated",
    "design",
  ),
];
