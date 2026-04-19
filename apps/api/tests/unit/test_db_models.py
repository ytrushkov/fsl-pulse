"""Unit tests for app.db.models — ORM model construction and column metadata."""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.db.models import Connector, Engagement, Survey


@pytest.mark.unit()
def test_engagement_tablename() -> None:
    assert Engagement.__tablename__ == "engagements"


@pytest.mark.unit()
def test_connector_tablename() -> None:
    assert Connector.__tablename__ == "connectors"


@pytest.mark.unit()
def test_survey_tablename() -> None:
    assert Survey.__tablename__ == "surveys"


@pytest.mark.unit()
def test_engagement_can_be_constructed() -> None:
    """Engagement ORM model can be instantiated with required fields."""
    eng = Engagement(
        client_name="TestCo",
        sponsor="Alice",
        team_count=5,
        kickoff_date=date(2026, 4, 1),
        target_delivery_date=date(2026, 10, 1),
        created_by="user-001",
    )
    assert eng.client_name == "TestCo"
    assert eng.sponsor == "Alice"
    assert eng.team_count == 5
    assert eng.created_by == "user-001"


@pytest.mark.unit()
def test_engagement_id_is_uuid_when_set_explicitly() -> None:
    eid = uuid.uuid4()
    eng = Engagement(
        id=eid,
        client_name="TestCo",
        sponsor="Bob",
        team_count=3,
        kickoff_date=date(2026, 1, 1),
        target_delivery_date=date(2026, 6, 1),
        created_by="user-002",
    )
    assert eng.id == eid


@pytest.mark.unit()
def test_engagement_status_column_default_value() -> None:
    """The 'status' column has a server-side default of 'draft'.
    At Python instantiation level, the column-level default is set as 'draft'
    via mapped_column default= which SQLAlchemy does assign for non-server defaults.
    """
    eng = Engagement(
        client_name="TestCo",
        sponsor="Alice",
        team_count=5,
        kickoff_date=date(2026, 4, 1),
        target_delivery_date=date(2026, 10, 1),
        created_by="user-001",
    )
    # SQLAlchemy mapped_column(default=...) sets the column default for INSERT but
    # does not assign it to the Python attribute until flush. Either None or "draft".
    assert eng.status in (None, "draft")


@pytest.mark.unit()
def test_connector_can_be_constructed() -> None:
    engagement_id = uuid.uuid4()
    conn = Connector(
        engagement_id=engagement_id,
        provider="github",
        credentials_ref="fake-kms:token",
    )
    assert conn.provider == "github"
    assert conn.engagement_id == engagement_id
    assert conn.credentials_ref == "fake-kms:token"


@pytest.mark.unit()
def test_connector_status_before_flush() -> None:
    """status has a column default='pending' applied at flush time, not Python init."""
    conn = Connector(
        engagement_id=uuid.uuid4(),
        provider="jira",
        credentials_ref="fake-kms:jira-token",
    )
    assert conn.status in (None, "pending")


@pytest.mark.unit()
def test_connector_last_run_at_is_nullable() -> None:
    conn = Connector(
        engagement_id=uuid.uuid4(),
        provider="github",
        credentials_ref="ref",
    )
    assert conn.last_run_at is None


@pytest.mark.unit()
def test_connector_provider_set_correctly() -> None:
    conn = Connector(
        engagement_id=uuid.uuid4(),
        provider="linear",
        credentials_ref="fake-kms:linear-token",
    )
    assert conn.provider == "linear"


@pytest.mark.unit()
def test_survey_can_be_constructed() -> None:
    survey = Survey(
        engagement_id=uuid.uuid4(),
        template_version="1.0.0",
    )
    assert survey.template_version == "1.0.0"


@pytest.mark.unit()
def test_survey_status_before_flush() -> None:
    """status has a column default='draft' applied at flush time, not Python init."""
    survey = Survey(
        engagement_id=uuid.uuid4(),
        template_version="2.0.0",
    )
    assert survey.status in (None, "draft")


@pytest.mark.unit()
def test_survey_template_version_set() -> None:
    survey = Survey(
        engagement_id=uuid.uuid4(),
        template_version="3.1.0",
    )
    assert survey.template_version == "3.1.0"


@pytest.mark.unit()
def test_engagement_relationships_attribute_exists() -> None:
    """ORM relationship descriptors must be present on the class."""
    assert hasattr(Engagement, "connectors")
    assert hasattr(Engagement, "surveys")


@pytest.mark.unit()
def test_connector_relationship_attribute_exists() -> None:
    assert hasattr(Connector, "engagement")


@pytest.mark.unit()
def test_survey_relationship_attribute_exists() -> None:
    assert hasattr(Survey, "engagement")


@pytest.mark.unit()
def test_engagement_kickoff_date_stored() -> None:
    d = date(2026, 5, 1)
    eng = Engagement(
        client_name="Co",
        sponsor="S",
        team_count=1,
        kickoff_date=d,
        target_delivery_date=date(2026, 12, 31),
        created_by="u",
    )
    assert eng.kickoff_date == d


@pytest.mark.unit()
def test_engagement_target_delivery_date_stored() -> None:
    d = date(2026, 12, 31)
    eng = Engagement(
        client_name="Co",
        sponsor="S",
        team_count=1,
        kickoff_date=date(2026, 1, 1),
        target_delivery_date=d,
        created_by="u",
    )
    assert eng.target_delivery_date == d
