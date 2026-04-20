"""Export (engagement bundle) schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ExportStatus(StrEnum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"


class ExportRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    version: int = Field(ge=1)
    status: ExportStatus
    file_manifest: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)
    exported_by: uuid.UUID
    created_at: datetime
    completed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)
