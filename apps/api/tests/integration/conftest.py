"""
Integration test conftest — fixtures that seed real DB rows and exercise
the full FastAPI request/response cycle through httpx.AsyncClient.

These fixtures depend on db_session and api_client from the root conftest
(apps/api/tests/conftest.py). Each fixture inserts data that is automatically
rolled back after the test completes — no manual cleanup required.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import TYPE_CHECKING

import pytest_asyncio

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


@pytest_asyncio.fixture
async def seeded_engagement(db_session: AsyncSession) -> dict:
    """
    Insert a minimal Engagement row and return its serialized representation.
    Used by tests that need a pre-existing engagement to act on.
    """
    from app.db.models import Engagement

    engagement_id = uuid.uuid4()
    engagement = Engagement(
        id=engagement_id,
        client_name="fixture-client",
        sponsor="fixture-sponsor",
        team_count=10,
        kickoff_date=date(2026, 4, 17),
        target_delivery_date=date(2026, 5, 17),
        status="draft",
        created_by="user-admin-001",
    )
    db_session.add(engagement)
    await db_session.flush()

    return {
        "id": str(engagement_id),
        "client_name": "fixture-client",
        "status": "draft",
    }


@pytest_asyncio.fixture
async def seeded_connector(
    db_session: AsyncSession,
    seeded_engagement: dict,
) -> dict:
    """
    Insert a minimal Connector row linked to the seeded_engagement.
    credentials_ref is a fake-kms reference — never a real secret.
    """
    from app.db.models import Connector

    connector_id = uuid.uuid4()
    connector = Connector(
        id=connector_id,
        engagement_id=uuid.UUID(seeded_engagement["id"]),
        provider="github",
        status="configured",
        credentials_ref="fake-kms:github-pat-fixture",
        scope_config={"repos": ["fixture-org/fixture-repo"]},
    )
    db_session.add(connector)
    await db_session.flush()

    return {
        "id": str(connector_id),
        "provider": "github",
        "engagement_id": seeded_engagement["id"],
    }


@pytest_asyncio.fixture
async def seeded_survey(
    db_session: AsyncSession,
    seeded_engagement: dict,
) -> dict:
    """
    Insert a minimal Survey row linked to the seeded_engagement.
    """
    from app.db.models import Survey

    survey_id = uuid.uuid4()
    survey = Survey(
        id=survey_id,
        engagement_id=uuid.UUID(seeded_engagement["id"]),
        template_version="1.0.0",
        status="draft",
        modules_enabled=[],
    )
    db_session.add(survey)
    await db_session.flush()

    return {
        "id": str(survey_id),
        "engagement_id": seeded_engagement["id"],
        "status": "draft",
    }
