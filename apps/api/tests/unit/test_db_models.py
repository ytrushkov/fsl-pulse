"""Unit tests for app.db.models — ORM model construction and column metadata."""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.db.models import (
    Artifact,
    AuditLog,
    Connector,
    ConnectorRun,
    Deliverable,
    Engagement,
    EngagementTemplate,
    Evidence,
    Export,
    Interview,
    Score,
    Survey,
    SurveyResponse,
    User,
)

# ---------------------------------------------------------------------------
# Tablename checks
# ---------------------------------------------------------------------------


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
def test_user_tablename() -> None:
    assert User.__tablename__ == "users"


@pytest.mark.unit()
def test_evidence_tablename() -> None:
    assert Evidence.__tablename__ == "evidence"


@pytest.mark.unit()
def test_score_tablename() -> None:
    assert Score.__tablename__ == "scores"


@pytest.mark.unit()
def test_artifact_tablename() -> None:
    assert Artifact.__tablename__ == "artifacts"


@pytest.mark.unit()
def test_interview_tablename() -> None:
    assert Interview.__tablename__ == "interviews"


@pytest.mark.unit()
def test_deliverable_tablename() -> None:
    assert Deliverable.__tablename__ == "deliverables"


@pytest.mark.unit()
def test_export_tablename() -> None:
    assert Export.__tablename__ == "exports"


@pytest.mark.unit()
def test_audit_log_tablename() -> None:
    assert AuditLog.__tablename__ == "audit_logs"


@pytest.mark.unit()
def test_connector_run_tablename() -> None:
    assert ConnectorRun.__tablename__ == "connector_runs"


@pytest.mark.unit()
def test_survey_response_tablename() -> None:
    assert SurveyResponse.__tablename__ == "survey_responses"


@pytest.mark.unit()
def test_engagement_template_tablename() -> None:
    assert EngagementTemplate.__tablename__ == "engagement_templates"


# ---------------------------------------------------------------------------
# Engagement construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_engagement_can_be_constructed() -> None:
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
    eng = Engagement(
        client_name="TestCo",
        sponsor="Alice",
        team_count=5,
        kickoff_date=date(2026, 4, 1),
        target_delivery_date=date(2026, 10, 1),
        created_by="user-001",
    )
    assert eng.status in (None, "draft")


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


@pytest.mark.unit()
def test_engagement_relationships_attribute_exists() -> None:
    assert hasattr(Engagement, "connectors")
    assert hasattr(Engagement, "surveys")
    assert hasattr(Engagement, "scores")
    assert hasattr(Engagement, "interviews")
    assert hasattr(Engagement, "artifacts")
    assert hasattr(Engagement, "audit_logs")


# ---------------------------------------------------------------------------
# Connector construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_connector_can_be_constructed() -> None:
    engagement_id = uuid.uuid4()
    conn = Connector(
        engagement_id=engagement_id,
        name="GitHub - acmecorp",
        provider="github",
        credentials_ref="fake-kms:token",
    )
    assert conn.provider == "github"
    assert conn.name == "GitHub - acmecorp"
    assert conn.engagement_id == engagement_id
    assert conn.credentials_ref == "fake-kms:token"


@pytest.mark.unit()
def test_connector_status_before_flush() -> None:
    conn = Connector(
        engagement_id=uuid.uuid4(),
        name="Jira",
        provider="jira",
        credentials_ref="fake-kms:jira-token",
    )
    assert conn.status in (None, "pending")


@pytest.mark.unit()
def test_connector_last_run_at_is_nullable() -> None:
    conn = Connector(
        engagement_id=uuid.uuid4(),
        name="gh",
        provider="github",
        credentials_ref="ref",
    )
    assert conn.last_run_at is None


@pytest.mark.unit()
def test_connector_provider_set_correctly() -> None:
    conn = Connector(
        engagement_id=uuid.uuid4(),
        name="Linear connector",
        provider="linear",
        credentials_ref="fake-kms:linear-token",
    )
    assert conn.provider == "linear"


@pytest.mark.unit()
def test_connector_relationship_attribute_exists() -> None:
    assert hasattr(Connector, "engagement")
    assert hasattr(Connector, "runs")


# ---------------------------------------------------------------------------
# Survey construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_survey_can_be_constructed() -> None:
    survey = Survey(
        engagement_id=uuid.uuid4(),
        template_version="1.0.0",
    )
    assert survey.template_version == "1.0.0"


@pytest.mark.unit()
def test_survey_status_before_flush() -> None:
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
def test_survey_relationship_attribute_exists() -> None:
    assert hasattr(Survey, "engagement")
    assert hasattr(Survey, "responses")


# ---------------------------------------------------------------------------
# User construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_user_can_be_constructed() -> None:
    user = User(
        email="alice@example.com",
        name="Alice",
        role="assessor",
        google_sub="google-sub-001",
    )
    assert user.email == "alice@example.com"
    assert user.name == "Alice"
    assert user.role == "assessor"


@pytest.mark.unit()
def test_user_is_active_default() -> None:
    user = User(
        email="bob@example.com",
        name="Bob",
        role="admin",
        google_sub="google-sub-002",
    )
    assert user.is_active in (None, True)


@pytest.mark.unit()
def test_user_last_login_at_nullable() -> None:
    user = User(
        email="carol@example.com",
        name="Carol",
        role="assessor",
        google_sub="google-sub-003",
    )
    assert user.last_login_at is None


# ---------------------------------------------------------------------------
# Evidence construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_evidence_can_be_constructed() -> None:
    eng_id = uuid.uuid4()
    ev = Evidence(
        engagement_id=eng_id,
        source_type="interview",
        source_ref="interview:acme:01#p1",
        dimension="tooling",
        signal_type="strength",
        text="Strong CI adoption.",
    )
    assert ev.dimension == "tooling"
    assert ev.signal_type == "strength"
    assert ev.source_type == "interview"


@pytest.mark.unit()
def test_evidence_accepted_by_nullable() -> None:
    ev = Evidence(
        engagement_id=uuid.uuid4(),
        source_type="connector",
        source_ref="github:run-1",
        dimension="process",
        signal_type="gap",
        text="No PR templates.",
    )
    assert ev.accepted_by is None


# ---------------------------------------------------------------------------
# Score construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_score_can_be_constructed() -> None:
    score = Score(
        engagement_id=uuid.uuid4(),
        dimension="culture",
        score=72,
        stage=3,
        confidence="M",
        rubric_version="1.0.0",
    )
    assert score.score == 72
    assert score.stage == 3
    assert score.confidence == "M"


@pytest.mark.unit()
def test_score_overrides_default_is_list() -> None:
    score = Score(
        engagement_id=uuid.uuid4(),
        dimension="people",
        score=55,
        stage=2,
        confidence="L",
        rubric_version="1.0.0",
    )
    assert score.overrides in (None, [])


# ---------------------------------------------------------------------------
# Artifact construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_artifact_can_be_constructed() -> None:
    artifact = Artifact(
        engagement_id=uuid.uuid4(),
        filename="policy.pdf",
        kind="governance",
        s3_key="uploads/policy.pdf",
        uploaded_by=uuid.uuid4(),
    )
    assert artifact.filename == "policy.pdf"
    assert artifact.kind == "governance"


# ---------------------------------------------------------------------------
# Interview construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_interview_can_be_constructed() -> None:
    interview = Interview(
        engagement_id=uuid.uuid4(),
        interviewee_role="vp_engineering",
        interview_date=date(2026, 2, 1),
        created_by=uuid.uuid4(),
    )
    assert interview.interviewee_role == "vp_engineering"


# ---------------------------------------------------------------------------
# ConnectorRun construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_connector_run_can_be_constructed() -> None:
    run = ConnectorRun(
        connector_id=uuid.uuid4(),
        engagement_id=uuid.uuid4(),
        status="running",
    )
    assert run.status == "running"


@pytest.mark.unit()
def test_connector_run_error_message_nullable() -> None:
    run = ConnectorRun(
        connector_id=uuid.uuid4(),
        engagement_id=uuid.uuid4(),
        status="pending",
    )
    assert run.error_message is None


# ---------------------------------------------------------------------------
# SurveyResponse construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_survey_response_can_be_constructed() -> None:
    resp = SurveyResponse(
        survey_id=uuid.uuid4(),
        engagement_id=uuid.uuid4(),
        anon_id="anon-abc123",
        responses={"q1": "A", "q2": "B"},
    )
    assert resp.anon_id == "anon-abc123"


# ---------------------------------------------------------------------------
# Deliverable construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_deliverable_can_be_constructed() -> None:
    deliv = Deliverable(
        engagement_id=uuid.uuid4(),
        kind="heatmap",
    )
    assert deliv.kind == "heatmap"


@pytest.mark.unit()
def test_deliverable_status_default() -> None:
    deliv = Deliverable(
        engagement_id=uuid.uuid4(),
        kind="report",
    )
    assert deliv.status in (None, "pending")


# ---------------------------------------------------------------------------
# Export construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_export_can_be_constructed() -> None:
    export = Export(
        engagement_id=uuid.uuid4(),
        exported_by=uuid.uuid4(),
        version=1,
    )
    assert export.version == 1


@pytest.mark.unit()
def test_export_s3_prefix_nullable() -> None:
    export = Export(
        engagement_id=uuid.uuid4(),
        exported_by=uuid.uuid4(),
    )
    assert export.s3_prefix is None


# ---------------------------------------------------------------------------
# AuditLog construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_audit_log_can_be_constructed() -> None:
    log = AuditLog(
        engagement_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        action="score.override",
        detail={"dimension": "tooling", "old": 72, "new": 75},
    )
    assert log.action == "score.override"
