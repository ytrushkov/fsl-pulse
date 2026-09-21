# Pulse — Project Instructions

## What is this project?
Pulse is FullStack's internal web app for automating the Agentic Development Maturity Assessment:
it diagnoses a client engineering org's agentic maturity across 6 dimensions × 5 stages, pulling
signals from connectors, surveys, and interviews, then produces scored deliverables.
Full PRD: see `docs/PRD.md`.

> **Stack migration (2026-09-21):** `main` was reseeded from a TypeScript build; the original
> Python/FastAPI scaffold is archived at tag `archive/python-scaffold`, and the full pre-reseed
> history is on branch `replit-import`. Rationale, comparison, and the remaining plan live in
> `REPLIT_MIGRATION_ASSESSMENT.md`. Some "de-Replit-ify" work is still in flight (see below).

## Tech stack
- Monorepo: **pnpm workspaces**, Node 24+, TypeScript 5.9
- Backend: **Express 5** (`artifacts/api-server`), routes mounted at `/api`; esbuild bundle
- Frontend: **React 19 + Vite** (`artifacts/pulse`), Tailwind, shadcn-style UI; **Clerk** for auth
- Data: **PostgreSQL + Drizzle ORM** (`lib/db`); schema in `lib/db/src/schema/pulse.ts`
- Validation: **Zod** (`zod/v4`), `drizzle-zod`
- API contract: **OpenAPI** (`lib/api-spec`) → Orval-generated Zod (`lib/api-zod`) + React Query
  hooks (`lib/api-client-react`). The spec is the source of truth; regenerate, don't hand-edit.
- LLM: Anthropic, via `lib/integrations-anthropic-ai`. **Target state:** route through an
  `llm-gateway` that strips PII before any provider call (migrating off the Replit-managed proxy).
- Tests: **vitest**

## Repo layout
- `artifacts/api-server` — Express backend (routes + `src/lib` business logic)
- `artifacts/pulse` — React/Vite assessor cockpit (8-tab engagement workspace)
- `artifacts/mockup-sandbox` — design sandbox (non-shipping)
- `lib/db`, `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`, `lib/integrations-anthropic-ai`
- `scripts` — workspace scripts

### Backend modules (`artifacts/api-server/src/lib`)
- `rubric.ts` / `rubric-store.ts` — built-in 6×5 rubric seed; versioned rubric CRUD (drafts
  editable, published rows immutable; `resolveRubricForScoring`: explicit id → latest published → seed)
- `scoring.ts` — evidence-weighted engine; source weights (system 1.5, artifact 1.2, interview 1.0,
  survey 0.8); type weights (strength +1, gap −0.7, risk −1, quote +0.3); anonymity floor ≥5;
  overrides clamped to [1..5]; per-rubric dimension weights on the overall; `{ rubricVersionId?, persist? }`
- `connectors.ts` + `connector-runner.ts` / `connector-fetch.ts` / `connector-metrics.ts` /
  `metrics.ts` / `derived-metrics.ts` — 6 connector families (GitHub, GitLab, Jira, Linear, CI/CD,
  AI tooling) with real provider APIs, resumable runs, shared percentile/flow-metric helpers
- `survey-template.ts` / `survey-scheduler.ts` — 30 core + 8 module Likert; scheduling
- `ai-deliverables.ts` / `npv-calc.ts` — Claude narratives (heatmap, gap analysis, 90-day plan,
  PDLC entry-point, NPV) + interview tag suggester; JSON-mode prompts with regex fallback
- `util.ts` / `kms.ts` — AES-256-GCM connector-token envelope encryption (key from `SESSION_SECRET`,
  override `PULSE_TOKEN_KEY`), HMAC-SHA256 export signing (`PULSE_EXPORT_KEY`), magic-link token
  hashing, SSRF allow-list (`checkSafeUrl`)
- `scheduler.ts` — in-process scheduler (durable queue/Temporal intentionally out of scope)
- `document-extract.ts` / `export-render.ts` / `objectStorage.ts` / `audit.ts` / `migrations.ts`

Routes: engagements, connectors, survey (+ public `/survey/respond/:token`), interviews, evidence,
artifacts, scoring, rubrics, deliverables, exports, portfolio, ai. Per-engagement authz is enforced
globally in `routes/index.ts`. Security posture documented in `artifacts/api-server/THREAT_MODEL.md`.

## Key commands
- `pnpm install` — install workspace
- `pnpm run typecheck` — full typecheck across all packages (run before committing)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate Zod schemas + hooks from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- `pnpm --filter @workspace/api-server run dev` — run the API server locally
- `pnpm --filter @workspace/pulse run dev` — run the frontend locally
- `pnpm --filter @workspace/api-server run test` — vitest

## Conventions
- **Typecheck must pass** (`tsc --noEmit`, strict). Prettier for formatting. No silent error swallowing.
- Tests: vitest; ≥80% line coverage on changed code. Connectors must use recorded HTTP fixtures
  (not live calls) and pass a conformance check.
- LLM calls go through the gateway (`lib/integrations-anthropic-ai` → target `llm-gateway`). **No
  raw PII to model providers.**
- The OpenAPI spec drives generated types — change the spec + regenerate; don't hand-edit generated
  packages (`lib/api-zod`, `lib/api-client-react`).
- Prefer composition over inheritance; keep modules a reasonable size.
- Secrets come from env (`SESSION_SECRET`, `PULSE_TOKEN_KEY`, `PULSE_EXPORT_KEY`, DB URL, Anthropic).
  Never commit `.env` or keys. (`.gitignore` still needs an `.env` rule added — see below.)

## In-flight / not yet established
- **eslint** config, **CI**, and a coverage gate are not set up yet on this stack (the Python-era
  CI was archived). To be established.
- **De-Replit-ify** (per `REPLIT_MIGRATION_ASSESSMENT.md`): object storage → S3/MinIO behind an
  interface; Anthropic proxy → `llm-gateway` with PII stripping; drop `.replit`/deploy config, add
  portable Docker + IaC.
- Deferred hardening: KMS key rotation, rate-limiting the public magic-link endpoint, DNS-rebinding
  defense on connector egress, fail-closed on missing `SESSION_SECRET` in prod.

## Repository conventions
`.gitignore` excludes local Claude settings, `CLAUDE.local.md`, build artifacts, and `node_modules`.
Note: the inherited `.gitignore` does **not** yet exclude `.env` / `*.key` / `*.secret` — add these.
