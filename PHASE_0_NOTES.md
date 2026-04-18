# Phase 0 — Repository & Toolchain Bootstrap: Decisions & Deviations

## Package naming convention

**Decision:** Python workspace packages live in `packages/<name>/` directories (with underscores), not `packages/<name>-sdk/` etc. The importable namespace via `PYTHONPATH=.` is `packages.<name>` (e.g., `packages.llm_gateway.client`). This matches the pre-written test fixtures.

**Why:** The conftest files (`tests/conftest.py:254`) monkeypatch `"packages.llm_gateway.client._gateway_client"`. Keeping `packages/` as a namespace parent makes PYTHONPATH=. the single mechanism for test imports.

## pytest `pythonpath = ["."]`

**Decision:** Added `pythonpath = ["."]` to `[tool.pytest.ini_options]` in root `pyproject.toml`.

**Why:** Ensures `packages.*` namespace imports work in local `make test` without requiring developers to export `PYTHONPATH=.` manually. CI already sets `PYTHONPATH: .` but local dev did not.

## hatchling `packages = ["."]`

**Decision:** Each internal package's `pyproject.toml` uses `packages = ["."]` instead of a named subdirectory.

**Why:** Source files (`__init__.py`, `client.py`, etc.) are placed directly inside `packages/<name>/`. The hatchling `packages` field points to the project root (`.`) so the editable install works without restructuring to a `src/` layout.

**Deviation from ideal:** A `src/` layout would be cleaner for installable packages. Deferred to Phase 1 when actual package APIs are defined.

## Docker build context

**Decision:** `docker-compose.yml` uses `context: ./apps/api` for the API service. This means the Dockerfile cannot COPY internal packages during image build.

**Why:** Phase 0 only needs `make test` (no Docker required). `make dev` with the full workspace build is a Phase 1 concern.

**Deviation:** Phase 0 acceptance criteria includes `make dev` → services healthy. The API container will not include `packages/*` unless the build context is changed. This is a known deferred item.

## Worker service

**Decision:** `app/worker/__init__.py` is a minimal asyncio stub. No Temporal workflows registered.

**Why:** Temporal integration begins in Phase 2 (Connector Data Collection). Phase 0 only needs the worker module to be importable.

## LLM gateway

**Decision:** `packages/llm_gateway/client.py` is a thin stub with `_gateway_client = None`. Tests override it via `monkeypatch.setattr`.

**Why:** No LLM calls in Phase 0. Real gateway logic (PII stripping, token budget) comes in Phase 3.
