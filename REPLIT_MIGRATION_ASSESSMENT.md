# Replit → Repo Migration Assessment

**Date:** 2026-09-21
**Author:** Prepared with Claude Code
**Decision recorded:** TypeScript/Node is the new direction for Pulse. This document compares the
Replit build against the current Python/FastAPI repo so we can plan the transition before moving
any code.

> Status: **decision doc — no code has moved yet.** The Replit history is fetched locally as
> `replit/main` (bundle import; unrelated history, no common ancestor with `origin/main`).

---

## 1. TL;DR

- The Replit build is a **near-complete v1 of the actual product**; this repo is **scaffolding only**.
- The two share **no git history and no stack overlap** — this is a replacement, not a merge.
- Recommended path: **make the Replit TypeScript monorepo the canonical codebase in this GitHub
  repo**, salvage a small set of governance/spec assets from the Python side, then "de-Replit-ify"
  for CI + off-Replit deploy.
- Biggest risks to close before this is production-grade: **test coverage**, **Replit platform
  lock-in** (Anthropic proxy, object storage, scheduler, deploy), and **LLM PII handling** vs. the
  `llm-gateway` mandate.

---

## 2. Scale, side by side

| Metric | This repo (`origin/main`) | Replit (`replit/main`) |
|---|---:|---:|
| Stack | Python 3.12 / FastAPI / SQLAlchemy / Pydantic | TypeScript 5.9 / Node 24 / Express 5 / Drizzle / Zod / React 19 + Vite |
| Commits | 5 | 120 |
| Source LOC (excl. tests) | ~871 | ~60,700 |
| Test LOC | ~2,904 | ~3,037 |
| Test files | ~20 | 13 |
| Workspace packages | 5 (Python) + web | 10 (pnpm) |
| API routes | health only | 15 route modules |
| Backend lib modules | — (models/schemas only) | ~35 |
| DB tables | 14 (SQLAlchemy) | 21 (Drizzle) |
| OpenAPI spec | generated stub | 2,705-line hand-maintained spec |
| Frontend | Next.js stub (1 page) | React cockpit, 88 component/page files, 8-tab workspace |
| Maturity | domain model + scaffolding | working end-to-end product |

The Replit source tree is roughly **70× the volume** of the Python source and contains the real
feature set. Note the low test ratio on the Replit side (~3k test LOC over ~61k source LOC, 13
files) — coverage is almost certainly **well below the repo's ≥80% mandate** and is unmeasured.

---

## 3. Feature coverage (mapped to PRD domains)

| PRD domain | This repo | Replit build |
|---|---|---|
| Engagements / templates | model + schema | ✅ routes + UI, full lifecycle |
| Connectors — source control (GitHub/GitLab) | model stub | ✅ real API verify+run, SC metrics |
| Connectors — issue tracking (Jira/Linear) | — | ✅ flow metrics (cycle/lead p50/75/95, WIP, throughput) |
| Connectors — CI/CD (Actions/GitLab CI/CircleCI/Jenkins) | — | ✅ |
| Connectors — Azure DevOps | — | ✅ |
| Connectors — AI tooling (Cursor/Claude Code/Windsurf/Amazon Q/Copilot) | — | ✅ |
| Cross-connector derived metrics | — | ✅ `derived-metrics.ts` |
| Resumable / checkpointed collection | model field | ✅ `connector-runner.ts` + lookback config |
| Rubric (6 dims × 5 stages), versioning | — | ✅ `rubric.ts` + versioned `rubric-store.ts` |
| Scoring engine (evidence-weighted, anonymity floor, overrides) | stub package | ✅ `scoring.ts`, per-rubric dimension weights |
| Surveys (30 core + 8 module Likert, magic-link) | model + schema | ✅ routes + scheduler + public respond endpoint |
| Interviews (consent, tagging) | model + schema | ✅ routes + AI tag suggester |
| Evidence | model + schema | ✅ routes |
| Artifacts / document extraction | model + schema | ✅ `document-extract.ts` + object storage |
| AI deliverables (heatmap, gap, 90-day plan, PDLC, NPV) | — | ✅ `ai-deliverables.ts`, `npv-calc.ts` (6 levers) |
| Exports (signed bundles, provenance) | model + schema | ✅ `export-render.ts`, HMAC signing + verify |
| Portfolio view | — | ✅ route + page |
| Audit log | model | ✅ `audit.ts` + `activity_events` |
| `assessment.json` canonical format | ✅ Pydantic schema + 3 fixtures | partial (DB-native, no single-file schema) |

**Takeaway:** the Replit build covers essentially the whole PRD; the Python side covers the data
model and one canonical serialization format.

---

## 4. Replit build inventory

**Workspace (pnpm, `artifacts/*` + `lib/*` + `scripts`):**
- `artifacts/api-server` — Express 5 backend, routes mounted at `/api`
- `artifacts/pulse` — React + Vite assessor cockpit (8-tab engagement workspace)
- `artifacts/mockup-sandbox` — design exploration sandbox (likely disposable)
- `lib/db` — Drizzle schema (`pulse.ts`, 21 tables) + migrations
- `lib/api-spec` — OpenAPI 2,705 lines + Orval codegen config
- `lib/api-zod` — generated Zod schemas
- `lib/api-client-react` — generated React Query hooks
- `lib/integrations-anthropic-ai` — **Replit-managed Anthropic proxy** (no API key needed)
- `scripts` — workspace scripts

**Backend modules of note** (`artifacts/api-server/src/lib`): `connectors.ts`, `connector-runner.ts`,
`connector-fetch.ts`, `connector-metrics.ts`, `derived-metrics.ts`, `metrics.ts`, `scoring.ts`,
`rubric.ts` / `rubric-store.ts`, `survey-template.ts`, `survey-scheduler.ts`, `scheduler.ts`,
`ai-deliverables.ts`, `npv-calc.ts`, `document-extract.ts`, `export-render.ts`, `objectStorage.ts`,
`kms.ts`, `util.ts` (AES-256-GCM token envelope, HMAC export signing, SSRF allow-list), `audit.ts`,
`migrations.ts`.

**Security posture:** documented `THREAT_MODEL.md`; connector PATs stored AES-256-GCM; magic-link
tokens HMAC-hashed; export bundles HMAC-signed with a verify endpoint; SSRF allow-list on outbound
connector URLs.

---

## 5. What to salvage from the Python repo

Small but real value — mostly governance and spec, not code:

- **PRD** (`docs:/Maturity-assessment-data-collection-tool_PRD.md`) — source of truth, keep.
  (Side note: the directory is literally named `docs:` with a trailing colon — a creation typo to
  fix during migration.)
- **`CLAUDE.md`** — rewrite the stack/conventions section for TS; keep the governance intent.
- **`assessment.json` schema + 3 fixtures** (`minimal`/`scored`/`complete`) — a clean canonical
  contract and ready-made test data; port to Zod and reuse as fixtures/round-trip tests.
- **CI patterns** (`.github/workflows/ci.yml`), **pre-commit**, **`.secrets.baseline`** — the
  *approach* carries over; the tooling must be re-expressed for pnpm/tsc/eslint/vitest.
- **`docker-compose.yml`** (Postgres/Redis/MinIO) — reusable for local dev if we deploy off Replit.

Everything else on the Python side (SQLAlchemy models, Pydantic schemas, FastAPI app, Python
packages) is **superseded** by the more complete Replit implementation.

---

## 6. Gaps & risks vs. team conventions

The current `CLAUDE.md` mandates carry over in spirit but need new enforcement, and a few are open
questions on the Replit build:

| Convention (CLAUDE.md) | Status in Replit build | Action |
|---|---|---|
| ruff + mypy --strict | prettier + tsc present; **eslint config unverified** | stand up eslint + strict tsc in CI |
| ≥80% line coverage on changed code | ~13 test files over ~61k LOC — **likely far below** | measure with vitest coverage; backfill critical paths |
| Connectors use recorded HTTP fixtures (vcrpy) + conformance suite | uses MSW-style mocks (unverified); **no vcrpy equivalent confirmed** | adopt a recorded-fixture approach (e.g. MSW recordings / Polly.js) + conformance tests |
| LLM calls via `llm-gateway`, **no raw PII to providers** | goes through Replit Anthropic proxy; **PII-stripping not confirmed** | audit `ai-deliverables.ts` inputs; add a gateway/PII layer |
| Temporal workers for async | in-process `scheduler.ts` / `survey-scheduler.ts` | decide: keep in-process vs. reintroduce a durable queue |
| IaC via Terraform | **none — Replit-native deploy** | write IaC if deploying off Replit |
| S3-compatible storage (MinIO) | Replit object storage (`objectStorage.ts`) | abstract storage / point at S3/MinIO |
| Modules ≤500 LOC | unverified (some lib modules likely large) | measure, refactor outliers |
| PHASE_n_NOTES.md per phase | Replit used "Task #NN" commits | re-establish phase notes going forward |

**Platform lock-in is the theme:** Anthropic proxy, object storage, in-process scheduler, and the
`.replit` / `.replit-artifact` deploy config all assume Replit hosting. Making this repo the
canonical, independently-deployable source means replacing each with a portable equivalent (or
consciously deciding to stay on Replit hosting).

---

## 7. Migration plan (decision-driven)

Phased so `main` is never left broken and each step is reviewable. Ordered by the Section 8
decisions.

**A. Preserve & vet (safe, non-destructive — do first)**
1. **Secret scan** `replit/main` locally (detect-secrets / gitleaks over the tree + history)
   *before anything is pushed to GitHub*. Scrub any hits.
2. **Preserve the Replit history** on GitHub as `replit-import` (full 120-commit history, nothing
   overwritten) once the scan is clean.
3. **Archive the Python scaffold** — tag/branch `archive/python-scaffold` from current `origin/main`.

**B. Reseed `main` (the cutover — consequential, needs explicit go-ahead)**
4. Reseed `main` from the Replit tree (same repo per #3). Python scaffold remains reachable via the
   archive ref from step 3.
5. **Graft salvaged assets** (Section 5): PRD (fix the `docs:` dir typo), rewritten `CLAUDE.md` for
   the TS stack, `assessment.json` contract → Zod + fixtures, docker-compose for local dev.

**C. De-Replit-ify (per #2 + #4 — required for off-Replit deploy)**
6. **Storage:** replace Replit object storage in `objectStorage.ts` with an S3/MinIO client behind
   an interface.
7. **LLM:** replace `lib/integrations-anthropic-ai` (Replit proxy) with a real Anthropic client
   behind an `llm-gateway` that strips PII before any call.
8. **Deploy config:** remove `.replit` / `.replit-artifact` / Replit vite plugins; add portable
   build + deploy (Docker) and IaC.
9. **Scheduler:** keep in-process per #5 — just confirm it runs outside Replit.

**D. Harden**
10. **CI for the TS stack:** pnpm install → tsc build → eslint → vitest with a coverage gate.
11. **Coverage & conformance backfill** on connectors and scoring (highest-value, highest-risk).
12. **Re-baseline the roadmap** in phase notes under the new stack.

---

## 8. Decisions (resolved 2026-09-21)

1. **Cutover shape** — ✅ **Reseed `main`** from the Replit tree; archive the Python scaffold to a
   branch/tag for reference.
2. **Hosting** — ✅ **Move off Replit (de-Replit-ify).** The app must be independently deployable:
   Replit object storage → S3/MinIO, Replit vite/deploy config removed, no `.replit` runtime deps.
3. **Repo identity** — ✅ **Same repo** (`ytrushkov/fsl-pulse`), new stack in place.
4. **LLM / PII** — ✅ **Move off the Replit Anthropic proxy.** Route through a real Anthropic API
   client behind an `llm-gateway` equivalent that strips PII before any provider call.
5. **Async model** — ✅ **Keep the in-process scheduler** (`scheduler.ts` / `survey-scheduler.ts`).
   No Temporal / durable queue for now.

These make hosting fully portable and remove every Replit platform dependency (storage, LLM,
deploy). The only Replit concept retained is the in-process scheduler, which is already portable.
