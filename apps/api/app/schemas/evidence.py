"""Evidence schemas — dimension-tagged observations from any source."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class SourceType(StrEnum):
    CONNECTOR = "connector"
    SURVEY = "survey"
    INTERVIEW = "interview"
    ARTIFACT = "artifact"


class Dimension(StrEnum):
    TOOLING = "tooling"
    MEASUREMENT = "measurement"
    PROCESS = "process"
    PEOPLE = "people"
    GOVERNANCE = "governance"
    CULTURE = "culture"


class SignalType(StrEnum):
    STRENGTH = "strength"
    GAP = "gap"
    RISK = "risk"
    QUOTE = "quote"


class EvidenceCreate(BaseModel):
    engagement_id: uuid.UUID
    source_type: SourceType
    source_ref: str
    interview_id: uuid.UUID | None = None
    dimension: Dimension
    signal_type: SignalType
    stage_hint: int | None = Field(default=None, ge=1, le=5)
    text: str

    model_config = ConfigDict(from_attributes=True)


class EvidenceRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    source_type: SourceType
    source_ref: str
    interview_id: uuid.UUID | None = None
    dimension: Dimension
    signal_type: SignalType
    stage_hint: int | None = None
    text: str
    accepted_by: uuid.UUID | None = None
    accepted_at: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EvidenceAccept(BaseModel):
    """Empty action body — POST /evidence/{id}/accept."""

    model_config = ConfigDict(from_attributes=True)
