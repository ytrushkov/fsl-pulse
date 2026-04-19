from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import date, datetime  # noqa: TCH003 — needed at runtime for Pydantic

from pydantic import BaseModel, Field


class EngagementBase(BaseModel):
    client_name: str
    sponsor: str
    team_count: int = Field(gt=0)
    kickoff_date: date
    target_delivery_date: date


class EngagementCreate(EngagementBase):
    pass


class EngagementRead(EngagementBase):
    id: uuid.UUID
    status: str
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
