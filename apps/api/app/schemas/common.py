"""Common base schemas and generic response envelopes."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T", bound=BaseModel)


class UUIDModel(BaseModel):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)


class TimestampedModel(BaseModel):
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T] = Field(default_factory=list)
    total: int = Field(ge=0)
    limit: int = Field(ge=1)
    offset: int = Field(ge=0)

    model_config = ConfigDict(from_attributes=True)


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: dict[str, str] | None = None

    model_config = ConfigDict(from_attributes=True)
