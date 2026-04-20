"""User schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr

UserRole = Literal["assessor", "admin"]


class UserBase(BaseModel):
    email: EmailStr
    name: str
    role: UserRole

    model_config = ConfigDict(from_attributes=True)


class UserCreate(UserBase):
    google_sub: str


class UserRead(UserBase):
    id: uuid.UUID
    is_active: bool
    last_login_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class UserUpdate(BaseModel):
    name: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None

    model_config = ConfigDict(from_attributes=True)
