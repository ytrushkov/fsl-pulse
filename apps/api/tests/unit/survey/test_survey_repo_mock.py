"""Unit tests exercising the mock_survey_repo fixture from unit/conftest.py."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.unit()
async def test_mock_survey_repo_get_by_engagement_id_returns_none(
    mock_survey_repo: MagicMock,
) -> None:
    result = await mock_survey_repo.get_by_engagement_id(uuid.uuid4())
    assert result is None


@pytest.mark.unit()
async def test_mock_survey_repo_save_response_is_callable(
    mock_survey_repo: MagicMock,
) -> None:
    await mock_survey_repo.save_response({"answer": 1})
    mock_survey_repo.save_response.assert_awaited_once()


@pytest.mark.unit()
async def test_mock_survey_repo_count_responses_by_team_returns_empty_dict(
    mock_survey_repo: MagicMock,
) -> None:
    result = await mock_survey_repo.count_responses_by_team(uuid.uuid4())
    assert result == {}


@pytest.mark.unit()
async def test_mock_survey_repo_get_returns_configured_value(
    mock_survey_repo: MagicMock,
) -> None:
    """We can configure the mock to return a specific survey."""
    fake_survey = MagicMock()
    fake_survey.id = uuid.uuid4()
    fake_survey.status = "active"
    mock_survey_repo.get_by_engagement_id = AsyncMock(return_value=fake_survey)

    result = await mock_survey_repo.get_by_engagement_id(fake_survey.id)
    assert result.status == "active"


@pytest.mark.unit()
async def test_mock_survey_repo_count_returns_configured_counts(
    mock_survey_repo: MagicMock,
) -> None:
    mock_survey_repo.count_responses_by_team = AsyncMock(return_value={"team-a": 5, "team-b": 3})
    result = await mock_survey_repo.count_responses_by_team(uuid.uuid4())
    assert result["team-a"] == 5
    assert result["team-b"] == 3
