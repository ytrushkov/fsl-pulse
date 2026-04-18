# Pulse — Project Instructions

## What is this project?
Pulse is FullStack's internal web app for automating the Agentic Development Maturity Assessment.
Full PRD: see `docs/PRD.md`

## Tech stack
- Backend: Python 3.12, FastAPI, SQLAlchemy 2.0, Pydantic v2, Temporal (workers)
- Frontend: Next.js 14 (App Router), TypeScript 5, Tailwind CSS, shadcn/ui
- Data: PostgreSQL 16, Redis 7, S3-compatible storage (MinIO in dev)
- LLM: Anthropic API (Claude Sonnet 4.6, Opus 4.6, Haiku)
- IaC: Terraform, Docker Compose for local dev

## Conventions
- Python: ruff + mypy --strict. No silent exception swallowing.
- TypeScript: eslint + prettier + tsc --noEmit.
- Tests: pytest (backend), vitest (frontend). ≥80% line coverage on changed code.
- Connectors: must use recorded HTTP fixtures (vcrpy). Must pass SDK conformance suite.
- LLM calls: routed through packages/llm-gateway. No raw PII sent to model providers.
- Modules ≤500 LOC where reasonable. Prefer composition over inheritance.
- Every phase produces a PHASE_<n>_NOTES.md documenting decisions and deviations.

## Current phase
Phase 0 — Repository & Toolchain Bootstrap


## Repository Conventions

The `.gitignore` is pre-configured to exclude:
- `.claude/settings.local.json` (local Claude Code settings)
- `CLAUDE.local.md` (local-only instructions)
- Secret/env files (`.env`, `*.key`, `*.secret`)
- Common build artifacts (`node_modules/`, `dist/`, `build/`, `__pycache__/`)
