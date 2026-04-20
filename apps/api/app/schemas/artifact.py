"""Artifact (uploaded document) schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class ArtifactKind(StrEnum):
    ARCHITECTURE = "architecture"
    GOVERNANCE = "governance"
    ORG_CHART = "org_chart"
    TOOL_INVENTORY = "tool_inventory"
    OTHER = "other"


class ScanStatus(StrEnum):
    PENDING = "pending"
    CLEAN = "clean"
    INFECTED = "infected"


class ArtifactRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int = Field(ge=0)
    kind: ArtifactKind
    scan_status: ScanStatus
    extracted_text: str | None = None
    uploaded_by: uuid.UUID
    uploaded_at: datetime

    model_config = ConfigDict(from_attributes=True)
