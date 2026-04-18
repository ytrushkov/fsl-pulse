"""Unit tests for packages.shared_models.engagement — Pydantic schemas."""

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


@pytest.mark.unit()
def test_engagement_base_valid() -> None:
    e = EngagementBase(
        client_name="ACME Corp",
        sponsor="Jane Doe",
        team_count=5,
        kickoff_date=date(2026, 4, 1),
        target_delivery_date=date(2026, 6, 30),
    )
    assert e.client_name == "ACME Corp"
    assert e.team_count == 5


@pytest.mark.unit()
def test_engagement_base_team_count_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        EngagementBase(
            client_name="Bad",
            sponsor="S",
            team_count=0,  # must be > 0
            kickoff_date=date(2026, 1, 1),
            target_delivery_date=date(2026, 2, 1),
        )


@pytest.mark.unit()
def test_engagement_base_team_count_negative_raises() -> None:
    with pytest.raises(ValidationError):
        EngagementBase(
            client_name="Bad",
            sponsor="S",
            team_count=-3,
            kickoff_date=date(2026, 1, 1),
            target_delivery_date=date(2026, 2, 1),
        )


@pytest.mark.unit()
def test_engagement_base_missing_required_field_raises() -> None:
    with pytest.raises(ValidationError):
        EngagementBase(
            sponsor="S",
            team_count=1,
            kickoff_date=date(2026, 1, 1),
            target_delivery_date=date(2026, 2, 1),
        )


@pytest.mark.unit()
def test_engagement_create_inherits_base() -> None:
    e = EngagementCreate(
        client_name="FullStack",
        sponsor="Alice",
        team_count=10,
        kickoff_date=date(2026, 5, 1),
        target_delivery_date=date(2026, 8, 1),
    )
    assert isinstance(e, EngagementBase)


@pytest.mark.unit()
def test_engagement_read_from_attributes() -> None:
    eid = uuid.uuid4()
    now = datetime.now(UTC)
    e = EngagementRead(
        id=eid,
        client_name="ClientX",
        sponsor="Bob",
        team_count=3,
        kickoff_date=date(2026, 3, 1),
        target_delivery_date=date(2026, 9, 1),
        status="active",
        created_by="user-001",
        created_at=now,
        updated_at=now,
    )
    assert e.id == eid
    assert e.status == "active"
    assert e.created_by == "user-001"


@pytest.mark.unit()
def test_engagement_read_model_config_from_attributes() -> None:
    """EngagementRead must have from_attributes=True for ORM usage."""
    assert EngagementRead.model_config.get("from_attributes") is True


@pytest.mark.unit()
def test_engagement_read_missing_id_raises() -> None:
    now = datetime.now(UTC)
    with pytest.raises(ValidationError):
        EngagementRead(
            client_name="X",
            sponsor="Y",
            team_count=1,
            kickoff_date=date(2026, 1, 1),
            target_delivery_date=date(2026, 2, 1),
            status="draft",
            created_by="user-001",
            created_at=now,
            updated_at=now,
            # id is missing
        )


@pytest.mark.unit()
def test_engagement_base_date_fields_are_dates() -> None:
    e = EngagementBase(
        client_name="Test",
        sponsor="S",
        team_count=2,
        kickoff_date=date(2026, 1, 15),
        target_delivery_date=date(2026, 12, 31),
    )
    assert isinstance(e.kickoff_date, date)
    assert isinstance(e.target_delivery_date, date)
