"""
Unit test conftest — lightweight overrides for pure unit tests.

Unit tests must NOT touch the real database. They receive a MagicMock
repository layer so the domain logic is tested in complete isolation.
The session-level db_engine fixture from the root conftest is NOT requested
here — this prevents accidental DB connections from unit tests.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture()
def mock_engagement_repo() -> MagicMock:
    """In-memory stub for the EngagementRepository."""
    repo = MagicMock()
    repo.get_by_id = AsyncMock(return_value=None)
    repo.list_all = AsyncMock(return_value=[])
    repo.create = AsyncMock()
    repo.update = AsyncMock()
    repo.delete = AsyncMock()
    return repo


@pytest.fixture()
def mock_connector_repo() -> MagicMock:
    """In-memory stub for the ConnectorRepository."""
    repo = MagicMock()
    repo.get_by_id = AsyncMock(return_value=None)
    repo.list_for_engagement = AsyncMock(return_value=[])
    repo.upsert_run = AsyncMock()
    return repo


@pytest.fixture()
def mock_survey_repo() -> MagicMock:
    """In-memory stub for the SurveyRepository."""
    repo = MagicMock()
    repo.get_by_engagement_id = AsyncMock(return_value=None)
    repo.save_response = AsyncMock()
    repo.count_responses_by_team = AsyncMock(return_value={})
    return repo


@pytest.fixture()
def mock_score_repo() -> MagicMock:
    """In-memory stub for the ScoreRepository."""
    repo = MagicMock()
    repo.get_by_engagement_id = AsyncMock(return_value=None)
    repo.save = AsyncMock()
    return repo
