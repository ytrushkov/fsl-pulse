"""Interview schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import date, datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class InterviewStatus(StrEnum):
    DRAFT = "draft"
    TAGGED = "tagged"
    REVIEWED = "reviewed"


class InterviewCreate(BaseModel):
    engagement_id: uuid.UUID
    interviewee_role: str
    interview_date: date
    consent_given: bool
    notes_md: str

    model_config = ConfigDict(from_attributes=True)


class InterviewRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    interviewee_role: str
    interview_date: date
    consent_given: bool
    notes_md: str | None = None
    status: InterviewStatus
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    evidence_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class InterviewUpdate(BaseModel):
    interviewee_role: str | None = None
    interview_date: date | None = None
    consent_given: bool | None = None
    notes_md: str | None = None
    status: InterviewStatus | None = None

    model_config = ConfigDict(from_attributes=True)
