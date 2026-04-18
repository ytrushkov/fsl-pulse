"""Unit tests exercising the mock_engagement_repo fixture from unit/conftest.py."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.unit()
async def test_mock_engagement_repo_get_by_id_returns_none_by_default(
    mock_engagement_repo: MagicMock,
) -> None:
    result = await mock_engagement_repo.get_by_id(uuid.uuid4())
    assert result is None


@pytest.mark.unit()
async def test_mock_engagement_repo_list_all_returns_empty_list(
    mock_engagement_repo: MagicMock,
) -> None:
    result = await mock_engagement_repo.list_all()
    assert result == []


@pytest.mark.unit()
async def test_mock_engagement_repo_create_is_callable(
    mock_engagement_repo: MagicMock,
) -> None:
    fake_engagement = MagicMock()
    await mock_engagement_repo.create(fake_engagement)
    mock_engagement_repo.create.assert_awaited_once_with(fake_engagement)


@pytest.mark.unit()
async def test_mock_engagement_repo_update_is_callable(
    mock_engagement_repo: MagicMock,
) -> None:
    eng_id = uuid.uuid4()
    await mock_engagement_repo.update(eng_id, {"status": "active"})
    mock_engagement_repo.update.assert_awaited_once()


@pytest.mark.unit()
async def test_mock_engagement_repo_delete_is_callable(
    mock_engagement_repo: MagicMock,
) -> None:
    eng_id = uuid.uuid4()
    await mock_engagement_repo.delete(eng_id)
    mock_engagement_repo.delete.assert_awaited_once_with(eng_id)


@pytest.mark.unit()
async def test_mock_engagement_repo_get_returns_configured_value(
    mock_engagement_repo: MagicMock,
) -> None:
    fake = MagicMock()
    fake.id = uuid.uuid4()
    fake.client_name = "ACME"
    mock_engagement_repo.get_by_id = AsyncMock(return_value=fake)

    result = await mock_engagement_repo.get_by_id(fake.id)
    assert result.client_name == "ACME"


@pytest.mark.unit()
async def test_mock_engagement_repo_list_all_returns_multiple_items(
    mock_engagement_repo: MagicMock,
) -> None:
    items = [MagicMock(), MagicMock()]
    mock_engagement_repo.list_all = AsyncMock(return_value=items)
    result = await mock_engagement_repo.list_all()
    assert len(result) == 2
