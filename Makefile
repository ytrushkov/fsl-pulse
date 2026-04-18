SHELL := /usr/bin/env bash
.ONESHELL:
.DEFAULT_GOAL := help
export COMPOSE_PROJECT_NAME := pulse

# ── Bootstrap ─────────────────────────────────────────────────────────────────
.PHONY: bootstrap
bootstrap:
	command -v uv   >/dev/null || pip install uv
	command -v pnpm >/dev/null || npm install -g pnpm@9
	uv sync --all-packages --dev
	pnpm install --frozen-lockfile
	pre-commit install --install-hooks
	cp -n .env.example .env || true

# ── Dev ───────────────────────────────────────────────────────────────────────
.PHONY: dev
dev:
	docker compose up -d --build db redis minio temporal
	./scripts/wait-for-healthy.sh db redis minio
	docker compose up -d --build api worker web
	./scripts/wait-for-healthy.sh api web
	@echo ""
	@echo "  API:      http://localhost:8000/docs"
	@echo "  Web:      http://localhost:3000"
	@echo "  MinIO:    http://localhost:9001"

.PHONY: dev-down
dev-down:
	docker compose down

.PHONY: dev-clean
dev-clean:
	docker compose down -v --remove-orphans

.PHONY: logs
logs:
	docker compose logs -f api web worker

# ── Test ──────────────────────────────────────────────────────────────────────
.PHONY: test
test: test-py test-ts

.PHONY: test-py
test-py:
	uv run pytest apps/api/tests packages -q --maxfail=5

.PHONY: test-ts
test-ts:
	pnpm --filter "./apps/web" run test -- --run
	pnpm --filter "./apps/web" run typecheck

.PHONY: test-connectors
test-connectors:
	uv run pytest tests/connectors -q --vcr-record=none

.PHONY: test-coverage
test-coverage:
	uv run pytest apps/api/tests packages \
		--cov=apps/api \
		--cov=packages \
		--cov-report=term-missing \
		--cov-report=xml:coverage.xml \
		--cov-fail-under=80

# ── Lint ──────────────────────────────────────────────────────────────────────
.PHONY: lint
lint: lint-py lint-ts

.PHONY: lint-py
lint-py:
	uv run ruff check apps/api packages
	uv run ruff format --check apps/api packages
	uv run mypy apps/api packages

.PHONY: lint-ts
lint-ts:
	pnpm --filter "./apps/web" run lint
	pnpm --filter "./apps/web" run typecheck

.PHONY: format
format:
	uv run ruff format apps/api packages
	uv run ruff check --fix apps/api packages
	pnpm --filter "./apps/web" exec prettier --write .

# ── Database ──────────────────────────────────────────────────────────────────
.PHONY: migrate
migrate:
	docker compose exec api uv run alembic -c alembic.ini upgrade head

.PHONY: migrate-create
migrate-create:
	@read -p "Migration name: " name; \
	docker compose exec api uv run alembic -c alembic.ini revision --autogenerate -m "$$name"

.PHONY: migrate-down
migrate-down:
	docker compose exec api uv run alembic -c alembic.ini downgrade -1

.PHONY: seed
seed:
	docker compose exec api uv run python -m scripts.seed

# ── Codegen ───────────────────────────────────────────────────────────────────
.PHONY: openapi
openapi:
	./scripts/generate-openapi.sh

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^\.PHONY: [a-zA-Z_-]+' Makefile \
		| awk '{print "  " $$2}' \
		| sort
