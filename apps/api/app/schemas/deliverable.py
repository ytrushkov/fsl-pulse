"""Deliverable schemas — heatmap, gap analysis, action plan, entry point, NPV."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class DeliverableKind(StrEnum):
    HEATMAP = "heatmap"
    GAP_ANALYSIS = "gap_analysis"
    ACTION_PLAN = "action_plan"
    PDLC_ENTRY_POINT = "pdlc_entry_point"
    NPV = "npv"


class DeliverableStatus(StrEnum):
    DRAFT = "draft"
    REVIEWED = "reviewed"
    LOCKED = "locked"


class DeliverableRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    kind: DeliverableKind
    status: DeliverableStatus
    content: dict[str, Any] = Field(default_factory=dict)
    locked_by: uuid.UUID | None = None
    locked_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DeliverableUpdate(BaseModel):
    content: dict[str, Any] | None = None
    status: DeliverableStatus | None = None

    model_config = ConfigDict(from_attributes=True)
