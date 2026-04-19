"""
Root conftest.py — fixtures available to every test in the backend suite.

Hierarchy:
  conftest.py  (this file)          <- session-scoped DB engine, async event loop
  unit/conftest.py                  <- in-memory or mocked dependencies
  integration/conftest.py           <- real HTTP client against a live test app
  connectors/conftest.py            <- vcrpy cassette directory + auth mocks

Design decisions:
  - Use a REAL Postgres instance (testcontainers or the docker-compose service).
    PRD build-plan: "integration over mocks" for persistence.
  - Each test gets its own transaction that is rolled back after the test
    (transactional isolation, no truncation overhead).
  - The async event loop is session-scoped to avoid re-creating it per test.
  - Secrets are never real; a fake KMS client is substituted at import time.
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Any
from unittest.mock import AsyncMock, MagicMock

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio  # — registers asyncio mode
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# ---------------------------------------------------------------------------
# Environment guard — tests MUST NOT point at a production database.
# ---------------------------------------------------------------------------
_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://pulse:pulse@localhost:5433/pulse_test",
)

if "pulse_test" not in _DATABASE_URL:
    raise OSError(
        "TEST_DATABASE_URL must target a dedicated test database (pulse_test). "
        f"Got: {_DATABASE_URL}"
    )


# ---------------------------------------------------------------------------
# Event loop — session-scoped so all async fixtures share one loop.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def event_loop():
    """Session-scoped event loop required by pytest-asyncio with async fixtures."""
    policy = asyncio.DefaultEventLoopPolicy()
    loop = policy.new_event_loop()
    yield loop
    loop.close()


# ---------------------------------------------------------------------------
# Database engine — created once per session, shared across all tests.
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture(scope="session")
async def db_engine() -> AsyncGenerator[AsyncEngine, None]:
    """
    Create the SQLAlchemy async engine pointed at the test database.

    In CI this is the postgres service container in .github/workflows/test.yml.
    Locally this is the docker-compose postgres with port 5433 exposed.
    """
    from app.db.base import Base

    engine = create_async_engine(
        _DATABASE_URL,
        echo=False,
        pool_size=5,
        max_overflow=0,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


# ---------------------------------------------------------------------------
# Transactional isolation — each test runs inside a transaction that is
# rolled back after the test, leaving the DB in a clean state with zero
# truncation overhead.
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def db_connection(db_engine: AsyncEngine) -> AsyncGenerator[AsyncConnection, None]:
    """
    A single database connection with an open transaction.
    All ORM operations are nested inside a SAVEPOINT so the outer transaction
    can be rolled back without touching any committed state.
    """
    async with db_engine.connect() as conn:
        await conn.begin()
        yield conn
        await conn.rollback()


@pytest_asyncio.fixture
async def db_session(db_connection: AsyncConnection) -> AsyncGenerator[AsyncSession, None]:
    """
    An AsyncSession bound to the transactional connection.
    Use this in unit and integration tests that need the ORM.
    """
    session_factory = async_sessionmaker(
        bind=db_connection,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    async with session_factory() as session:
        yield session


# ---------------------------------------------------------------------------
# Application — FastAPI app with overridden dependencies.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def app():
    """
    Import and return the FastAPI application.
    Session scope means the app is only imported once; per-test dependency
    overrides are applied via the db_session fixture below.
    """
    from app.main import create_app

    return create_app()


@pytest_asyncio.fixture
async def api_client(
    app: Any,
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncClient, None]:
    """
    An httpx.AsyncClient wired to the FastAPI test app with the
    transactional db_session injected via dependency override.
    Headers do NOT include auth by default — use auth_headers_* fixtures.
    """
    from app.db.session import get_session

    async def _override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Authentication — fake JWTs for role-based tests.
# ---------------------------------------------------------------------------
@pytest.fixture()
def assessor_token() -> str:
    """A signed JWT representing an Assessor-role user (uses test secret key)."""
    from app.auth.tokens import create_access_token

    return create_access_token(
        {
            "sub": "user-assessor-001",
            "email": "assessor@fullstacklabs.co",
            "role": "assessor",
        }
    )


@pytest.fixture()
def admin_token() -> str:
    """A signed JWT representing an Admin-role user."""
    from app.auth.tokens import create_access_token

    return create_access_token(
        {
            "sub": "user-admin-001",
            "email": "admin@fullstacklabs.co",
            "role": "admin",
        }
    )


@pytest.fixture()
def auth_headers_assessor(assessor_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {assessor_token}"}


@pytest.fixture()
def auth_headers_admin(admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {admin_token}"}


# ---------------------------------------------------------------------------
# KMS / Secrets — fake implementation so no AWS calls leave the test suite.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _fake_kms(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Replace the KMS client with a no-op that stores ciphertext as plaintext
    prefixed with 'fake-kms:'. This keeps connector tests fast and offline.
    autouse=True means every test gets this without opting in.

    Real secrets must never appear in test fixtures or cassettes.
    The cassette scrubbing strategy in connectors/conftest.py enforces this
    at the HTTP layer.
    """
    fake = MagicMock()
    fake.encrypt = MagicMock(side_effect=lambda plaintext: f"fake-kms:{plaintext}")
    fake.decrypt = MagicMock(side_effect=lambda ciphertext: ciphertext.removeprefix("fake-kms:"))
    monkeypatch.setattr("app.secrets.kms._client", fake)


# ---------------------------------------------------------------------------
# LLM Gateway — stub so no real Anthropic calls happen in any test.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _stub_llm_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Replace the llm-gateway client with a stub returning deterministic
    responses. Individual tests that need specific model outputs should
    override this fixture locally with more specific mocks.

    LLM call policy (PRD cross-cutting conventions): all model calls go
    through packages/llm-gateway. This stub enforces the policy by making
    the real Anthropic SDK unavailable — if any code bypasses the gateway
    and calls the Anthropic SDK directly, the request will fail in CI
    (ANTHROPIC_API_KEY is not set) and be caught immediately.
    """
    stub = AsyncMock()
    stub.complete.return_value = MagicMock(
        content="stub-llm-response",
        model="claude-sonnet-4-6",
        usage=MagicMock(input_tokens=10, output_tokens=5),
        prompt_hash="sha256:stub",
        response_hash="sha256:stub-response",
    )
    monkeypatch.setattr("packages.llm_gateway.client._gateway_client", stub)


# ---------------------------------------------------------------------------
# Fixture data helpers.
# ---------------------------------------------------------------------------
@pytest.fixture()
def fixture_path():
    """Return the absolute path to the tests/fixtures directory."""
    import pathlib

    return pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture()
def assessment_fixture(fixture_path):
    """
    Load the canonical minimal assessment fixture as a dict.
    Matches the assessment.json schema from PRD §8.
    """
    import json

    return json.loads((fixture_path / "assessments" / "minimal.json").read_text())
