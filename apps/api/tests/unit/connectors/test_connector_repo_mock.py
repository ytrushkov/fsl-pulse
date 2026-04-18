"""Unit tests exercising the mock_connector_repo fixture from unit/conftest.py."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.unit()
async def test_mock_connector_repo_get_by_id_returns_none_default(
    mock_connector_repo: MagicMock,
) -> None:
    result = await mock_connector_repo.get_by_id(uuid.uuid4())
    assert result is None


@pytest.mark.unit()
async def test_mock_connector_repo_list_for_engagement_returns_empty_list(
    mock_connector_repo: MagicMock,
) -> None:
    result = await mock_connector_repo.list_for_engagement(uuid.uuid4())
    assert result == []


@pytest.mark.unit()
async def test_mock_connector_repo_upsert_run_is_callable(
    mock_connector_repo: MagicMock,
) -> None:
    conn_id = uuid.uuid4()
    await mock_connector_repo.upsert_run(conn_id, {"status": "success"})
    mock_connector_repo.upsert_run.assert_awaited_once()


@pytest.mark.unit()
async def test_mock_connector_repo_get_returns_configured_value(
    mock_connector_repo: MagicMock,
) -> None:
    fake = MagicMock()
    fake.provider = "github"
    mock_connector_repo.get_by_id = AsyncMock(return_value=fake)

    result = await mock_connector_repo.get_by_id(uuid.uuid4())
    assert result.provider == "github"


@pytest.mark.unit()
async def test_mock_connector_repo_list_returns_multiple_connectors(
    mock_connector_repo: MagicMock,
) -> None:
    items = [MagicMock(provider="github"), MagicMock(provider="jira")]
    mock_connector_repo.list_for_engagement = AsyncMock(return_value=items)
    result = await mock_connector_repo.list_for_engagement(uuid.uuid4())
    assert len(result) == 2
    assert result[0].provider == "github"
    assert result[1].provider == "jira"
