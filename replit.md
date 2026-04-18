# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Pulse — Agentic Maturity Assessment Platform (v1)

FullStack's internal product for diagnosing client engineering org agentic maturity.

### Artifacts
- `artifacts/api-server` — Express 5 backend (Pulse routes mounted at `/api`)
- `artifacts/pulse` — React + Vite cockpit-style assessor UI (8-tab engagement workspace)
- `artifacts/mockup-sandbox` — design exploration sandbox

### Backend modules (`artifacts/api-server/src/lib`)
- `rubric.ts` — 6 dimensions × 5 stages (versioned, RUBRIC_VERSION = 1.0.0)
- `survey-template.ts` — 30 core Likert + 8 optional module questions
- `scoring.ts` — evidence-weighted scoring engine; signal-source weights (system 1.5, artifact 1.2, interview 1.0, survey 0.8); signal-type weights (strength +1, gap −0.7, risk −1, quote +0.3); anonymity floor ≥5 enforced; overrides clamped to rubric bounds [1..5]; connector runs scoped per engagement
- `connectors.ts` — 6 families: GitHub, GitLab, Jira, Linear, CI/CD, AI tooling; real verify + run with provider APIs
- `ai-deliverables.ts` — claude-sonnet-4-6 narratives (heatmap, gap analysis, 90-day plan, PDLC entry-point, NPV) + interview tag suggester; JSON-mode prompts with regex fallback parsing
- `util.ts` — AES-256-GCM connector-token envelope encryption (HKDF-derived key from `SESSION_SECRET`, override via `PULSE_TOKEN_KEY`), HMAC-SHA256 export signing (override via `PULSE_EXPORT_KEY`), magic-link token hashing, SSRF allow-list (`checkSafeUrl`)

### Routes (`artifacts/api-server/src/routes`)
engagements, connectors, survey (incl. public `/survey/respond/:token`), interviews, evidence, artifacts, scoring, deliverables, exports, ai

### Database (`lib/db/src/schema/pulse.ts`)
engagements, connectors, connector_runs, surveys, survey_invites, survey_responses, interviews, evidence, artifact_docs, scoring, score_overrides, deliverables, exports, activity_events

### AI integration
`lib/integrations-anthropic-ai` (Replit-managed Anthropic proxy, no API key needed)

### Security posture (Task #2 hardening — see `artifacts/api-server/THREAT_MODEL.md`)
- Connector PATs stored as AES-256-GCM ciphertext (`v1:iv:tag:ct`); legacy base64 rows still readable for back-compat
- Magic-link survey tokens HMAC-hashed before storage; `expires_at` (default 30d, `PULSE_INVITE_TTL_MS` override); generic "invalid or expired" error
- Export bundles signed with HMAC-SHA256; `POST /exports/:exportId/verify` confirms a submitted snapshot; `keyFingerprint` exposes which key signed without leaking it
- Per-engagement authz enforced globally in `routes/index.ts` (regex-matched `/engagements/:id/...` → `requireEngagementMember`); owner-only member mgmt
- SSRF allow-list on user-supplied `baseUrl` (GitLab self-managed, Jira); defense-in-depth re-check in `lib/connectors.ts` at fetch time
### Remaining hardening (deferred to later tasks)
- KMS integration for key rotation (currently HKDF-derived from `SESSION_SECRET`)
- Rate-limiting on public magic-link endpoint
- Egress proxy / DNS pinning to defeat DNS rebinding on connector calls
- Fail-closed on missing `SESSION_SECRET` in production
