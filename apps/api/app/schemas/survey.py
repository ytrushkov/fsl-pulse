"""Survey schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class SurveyModule(StrEnum):
    SECURITY = "security"
    DATA_ANALYTICS = "data_analytics"
    PLATFORM_ENGINEERING = "platform_engineering"
    PRODUCT_DESIGN = "product_design"


class QuestionType(StrEnum):
    LIKERT = "likert"
    MULTI_SELECT = "multi_select"
    SINGLE_SELECT = "single_select"
    RANK_ORDER = "rank_order"
    CONDITIONAL = "conditional"


class Question(BaseModel):
    id: str
    text: str
    type: QuestionType
    options: list[str] = Field(default_factory=list)
    conditional_on: str | None = None

    model_config = ConfigDict(from_attributes=True)


class SurveyCreate(BaseModel):
    engagement_id: uuid.UUID
    template_version: str
    modules_enabled: list[SurveyModule] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class SurveyRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    template_version: str
    modules_enabled: list[SurveyModule] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SurveyResponseRead(BaseModel):
    """Anonymized survey response metadata.

    Deliberately excludes the raw `responses` payload — aggregates only.
    """

    id: uuid.UUID
    anon_id: str
    team: str | None = None
    tenure_band: str | None = None
    role_category: str | None = None
    submitted_at: datetime

    model_config = ConfigDict(from_attributes=True)
