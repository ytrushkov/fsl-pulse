"""Canonical `assessment.json` schema — the round-trip serializer root.

This mirrors §8 of the PRD. It is the single source of truth for the
export/import contract used by the scoring engine, the deliverables
compiler, and the report generator.
"""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import date, datetime  # noqa: TCH003 — needed at runtime for Pydantic
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.evidence import (  # noqa: TCH001 — StrEnum values used at runtime by Pydantic validators
    Dimension,
    SignalType,
    SourceType,
)


class EngagementInfo(BaseModel):
    id: uuid.UUID
    client: str
    sponsor: str
    teams_in_scope: list[str] = Field(default_factory=list)
    kickoff_date: date
    target_delivery_date: date
    window: dict[str, date]

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class SystemMetrics(BaseModel):
    """Per-provider metric bag. Keys differ by connector, so extras are allowed."""

    model_config = ConfigDict(extra="allow")


class VCSSystem(BaseModel):
    provider: str
    org: str
    repos: list[str] = Field(default_factory=list)
    metrics: SystemMetrics = Field(default_factory=SystemMetrics)

    model_config = ConfigDict(from_attributes=True)


class IssueTrackerSystem(BaseModel):
    provider: str
    workspace: str
    projects: list[str] = Field(default_factory=list)
    metrics: SystemMetrics = Field(default_factory=SystemMetrics)

    model_config = ConfigDict(from_attributes=True)


class CISystem(BaseModel):
    provider: str
    pipelines: list[str] = Field(default_factory=list)
    metrics: SystemMetrics = Field(default_factory=SystemMetrics)

    model_config = ConfigDict(from_attributes=True)


class AIToolingSystem(BaseModel):
    provider: str
    seats: int | None = None
    active_users: int | None = None
    acceptance_rate: float | None = None
    edit_distance: float | None = None
    pdlc_coverage: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class Systems(BaseModel):
    vcs: list[VCSSystem] = Field(default_factory=list)
    issue_tracker: list[IssueTrackerSystem] = Field(default_factory=list)
    ci: list[CISystem] = Field(default_factory=list)
    ai_tooling: list[AIToolingSystem] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class EvidenceRecord(BaseModel):
    id: uuid.UUID
    source_type: SourceType
    source_ref: str
    dimension: Dimension
    signal_type: SignalType
    stage_hint: int | None = Field(default=None, ge=1, le=5)
    text: str
    created_by: uuid.UUID
    created_at: datetime
    accepted_by: uuid.UUID | None = None

    model_config = ConfigDict(from_attributes=True)


class DimensionData(BaseModel):
    evidence: list[EvidenceRecord] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    stage_hints: list[int] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class SurveyAggregate(BaseModel):
    template_version: str
    modules: list[str] = Field(default_factory=list)
    responses_by_team: list[dict[str, Any]] = Field(default_factory=list)
    aggregate_scores: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class InterviewRecord(BaseModel):
    id: uuid.UUID
    role_category: str
    date: date
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ArtifactRecord(BaseModel):
    id: uuid.UUID
    filename: str
    kind: str
    extracted_summary: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ScoreRecord(BaseModel):
    score: int = Field(ge=0, le=100)
    stage: int = Field(ge=1, le=5)
    confidence: str  # L|M|H — kept as str for round-trip flexibility
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)
    overrides: list[dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class Scores(BaseModel):
    rubric_version: str
    by_dimension: dict[str, ScoreRecord] = Field(default_factory=dict)
    overall: ScoreRecord

    model_config = ConfigDict(from_attributes=True)


class GapAnalysisItem(BaseModel):
    dimension: str
    current: int = Field(ge=1, le=5)
    target: int = Field(ge=1, le=5)
    gaps: list[str] = Field(default_factory=list)
    narrative_md: str = ""
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ActionPlanItem(BaseModel):
    initiative: str
    dimension: str
    priority: str  # P0|P1|P2
    effort: str  # XS|S|M|L|XL
    impact: str  # XS|S|M|L|XL
    owner: str
    success_metric: str
    dependencies: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class PDLCEntryPoint(BaseModel):
    recommended_stage: str
    hypr_agents: list[str] = Field(default_factory=list)
    rationale_md: str = ""
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class NPVScenario(BaseModel):
    npv_3yr: float
    payback_months: float
    irr: float
    breakdown: dict[str, float] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class NPVModel(BaseModel):
    model_version: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    scenarios: dict[str, NPVScenario] = Field(default_factory=dict)
    npv_3yr: float
    payback_months: float
    irr: float

    # Suppress Pydantic v2 warning about model_* namespace for model_version field.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())


class Deliverables(BaseModel):
    heatmap: dict[str, Any] = Field(default_factory=dict)
    gap_analysis: list[GapAnalysisItem] = Field(default_factory=list)
    action_plan: list[ActionPlanItem] = Field(default_factory=list)
    pdlc_entry_point: PDLCEntryPoint | None = None
    npv: NPVModel | None = None

    model_config = ConfigDict(from_attributes=True)


class Provenance(BaseModel):
    connector_runs: list[uuid.UUID] = Field(default_factory=list)
    rubric_version: str
    report_template_version: str
    export_version: int = Field(ge=1)
    exported_at: datetime
    signatures: dict[str, str] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class Assessment(BaseModel):
    """Root schema for `assessment.json` — the canonical normalized dataset."""

    engagement: EngagementInfo
    dimensions: dict[str, DimensionData] = Field(default_factory=dict)
    systems: Systems = Field(default_factory=Systems)
    survey: SurveyAggregate | None = None
    interviews: list[InterviewRecord] = Field(default_factory=list)
    artifacts: list[ArtifactRecord] = Field(default_factory=list)
    scores: Scores | None = None
    deliverables: Deliverables | None = None
    provenance: Provenance | None = None

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
