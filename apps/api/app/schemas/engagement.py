"""Engagement schemas (API request/response shapes)."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import date, datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EngagementStatus(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    COLLECTING = "collecting"
    READY_FOR_ANALYSIS = "ready_for_analysis"
    EXPORTED = "exported"
    ARCHIVED = "archived"


class EngagementCreate(BaseModel):
    client_name: str
    sponsor: str
    team_count: int = Field(gt=0)
    kickoff_date: date
    target_delivery_date: date
    description: str | None = None
    scope_definition: dict[str, Any] | None = None
    template_id: uuid.UUID | None = None

    model_config = ConfigDict(from_attributes=True)


class EngagementRead(BaseModel):
    id: uuid.UUID
    client_name: str
    sponsor: str
    team_count: int
    kickoff_date: date
    target_delivery_date: date
    description: str | None = None
    scope_definition: dict[str, Any] | None = None
    template_id: uuid.UUID | None = None
    status: EngagementStatus
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EngagementUpdate(BaseModel):
    client_name: str | None = None
    sponsor: str | None = None
    team_count: int | None = Field(default=None, gt=0)
    kickoff_date: date | None = None
    target_delivery_date: date | None = None
    description: str | None = None
    scope_definition: dict[str, Any] | None = None
    template_id: uuid.UUID | None = None
    status: EngagementStatus | None = None

    model_config = ConfigDict(from_attributes=True)


class EngagementListItem(BaseModel):
    id: uuid.UUID
    client_name: str
    status: EngagementStatus
    target_delivery_date: date
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
