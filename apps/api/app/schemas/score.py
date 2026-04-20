"""Score schemas — per-dimension scoring, overrides, and rubric metadata."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.evidence import (
    Dimension,  # noqa: TCH001 — StrEnum used at runtime by Pydantic validators
)


class Confidence(StrEnum):
    LOW = "L"
    MEDIUM = "M"
    HIGH = "H"


class ScoreOverride(BaseModel):
    user_id: uuid.UUID
    timestamp: datetime
    justification: str
    previous_score: int = Field(ge=0, le=100)

    model_config = ConfigDict(from_attributes=True)


class ScoreRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    dimension: Dimension
    score: int = Field(ge=0, le=100)
    stage: int = Field(ge=1, le=5)
    confidence: Confidence
    rubric_version: str
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)
    overrides: list[ScoreOverride] = Field(default_factory=list)
    computed_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ScoreOverrideRequest(BaseModel):
    justification: str
    new_score: int = Field(ge=0, le=100)

    model_config = ConfigDict(from_attributes=True)
