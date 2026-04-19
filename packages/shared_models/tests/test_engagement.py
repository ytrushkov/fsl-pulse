"""Unit tests for shared_models.engagement."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

import pytest
from packages.shared_models.engagement import (
    EngagementBase,
    EngagementCreate,
    EngagementRead,
)
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _base_kwargs(**overrides) -> dict:
    return {
        "client_name": "Acme Corp",
        "sponsor": "Jane Doe",
        "team_count": 5,
        "kickoff_date": date(2026, 1, 1),
        "target_delivery_date": date(2026, 6, 30),
        **overrides,
    }


def _read_kwargs(**overrides) -> dict:
    return {
        **_base_kwargs(),
        "id": uuid.uuid4(),
        "status": "active",
        "created_by": "yury@fullstacklabs.co",
        "created_at": datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 2, 12, 0, 0, tzinfo=UTC),
        **overrides,
    }


# ---------------------------------------------------------------------------
# EngagementBase
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_engagement_base_valid() -> None:
    model = EngagementBase(**_base_kwargs())
    assert model.client_name == "Acme Corp"
    assert model.sponsor == "Jane Doe"
    assert model.team_count == 5


@pytest.mark.unit()
def test_engagement_base_team_count_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        EngagementBase(**_base_kwargs(team_count=0))


@pytest.mark.unit()
def test_engagement_base_team_count_negative_raises() -> None:
    with pytest.raises(ValidationError):
        EngagementBase(**_base_kwargs(team_count=-3))


@pytest.mark.unit()
def test_engagement_base_team_count_one_is_valid() -> None:
    model = EngagementBase(**_base_kwargs(team_count=1))
    assert model.team_count == 1


@pytest.mark.unit()
def test_engagement_base_missing_client_name_raises() -> None:
    kwargs = _base_kwargs()
    del kwargs["client_name"]
    with pytest.raises(ValidationError):
        EngagementBase(**kwargs)


@pytest.mark.unit()
def test_engagement_base_missing_sponsor_raises() -> None:
    kwargs = _base_kwargs()
    del kwargs["sponsor"]
    with pytest.raises(ValidationError):
        EngagementBase(**kwargs)


@pytest.mark.unit()
def test_engagement_base_date_fields() -> None:
    model = EngagementBase(**_base_kwargs())
    assert model.kickoff_date == date(2026, 1, 1)
    assert model.target_delivery_date == date(2026, 6, 30)


# ---------------------------------------------------------------------------
# EngagementCreate
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_engagement_create_is_subclass_of_base() -> None:
    assert issubclass(EngagementCreate, EngagementBase)


@pytest.mark.unit()
def test_engagement_create_valid() -> None:
    model = EngagementCreate(**_base_kwargs())
    assert model.client_name == "Acme Corp"
    assert model.team_count == 5


@pytest.mark.unit()
def test_engagement_create_inherits_validation() -> None:
    with pytest.raises(ValidationError):
        EngagementCreate(**_base_kwargs(team_count=0))


# ---------------------------------------------------------------------------
# EngagementRead
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_engagement_read_valid() -> None:
    model = EngagementRead(**_read_kwargs())
    assert model.status == "active"
    assert isinstance(model.id, uuid.UUID)
    assert model.created_by == "yury@fullstacklabs.co"


@pytest.mark.unit()
def test_engagement_read_is_subclass_of_base() -> None:
    assert issubclass(EngagementRead, EngagementBase)


@pytest.mark.unit()
def test_engagement_read_from_attributes_config() -> None:
    config = EngagementRead.model_config
    assert config.get("from_attributes") is True


@pytest.mark.unit()
def test_engagement_read_id_is_uuid() -> None:
    fixed_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    model = EngagementRead(**_read_kwargs(id=fixed_id))
    assert model.id == fixed_id


@pytest.mark.unit()
def test_engagement_read_missing_id_raises() -> None:
    kwargs = _read_kwargs()
    del kwargs["id"]
    with pytest.raises(ValidationError):
        EngagementRead(**kwargs)


@pytest.mark.unit()
def test_engagement_read_missing_status_raises() -> None:
    kwargs = _read_kwargs()
    del kwargs["status"]
    with pytest.raises(ValidationError):
        EngagementRead(**kwargs)


@pytest.mark.unit()
def test_engagement_read_timestamps_are_datetime() -> None:
    model = EngagementRead(**_read_kwargs())
    assert isinstance(model.created_at, datetime)
    assert isinstance(model.updated_at, datetime)


@pytest.mark.unit()
def test_engagement_read_inherits_team_count_validation() -> None:
    with pytest.raises(ValidationError):
        EngagementRead(**_read_kwargs(team_count=0))


# ---------------------------------------------------------------------------
# Package-level import
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_shared_models_package_importable() -> None:
    import packages.shared_models as pkg

    assert pkg is not None
