"""Connector and connector-run schemas."""

from __future__ import annotations

import uuid  # noqa: TCH003 — needed at runtime for Pydantic
from datetime import datetime  # noqa: TCH003 — needed at runtime for Pydantic
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ConnectorProvider(StrEnum):
    GITHUB = "github"
    GITLAB = "gitlab"
    JIRA = "jira"
    LINEAR = "linear"
    CI_GITHUB_ACTIONS = "ci_github_actions"
    CI_CIRCLECI = "ci_circleci"
    CI_JENKINS = "ci_jenkins"
    CI_GITLAB = "ci_gitlab"
    AI_COPILOT = "ai_copilot"
    AI_CURSOR = "ai_cursor"
    AI_CLAUDE_CODE = "ai_claude_code"
    AI_WINDSURF = "ai_windsurf"
    AI_AMAZON_Q = "ai_amazon_q"


class ConnectorStatus(StrEnum):
    PENDING = "pending"
    CONFIGURED = "configured"
    COLLECTING = "collecting"
    COLLECTED = "collected"
    FAILED = "failed"
    REVOKED = "revoked"


class ConnectorRunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class ConnectorCreate(BaseModel):
    engagement_id: uuid.UUID
    provider: ConnectorProvider
    name: str
    config: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class ConnectorRead(BaseModel):
    id: uuid.UUID
    engagement_id: uuid.UUID
    provider: ConnectorProvider
    name: str
    config: dict[str, Any] = Field(default_factory=dict)
    status: ConnectorStatus
    last_run_at: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConnectorRunRead(BaseModel):
    id: uuid.UUID
    connector_id: uuid.UUID
    engagement_id: uuid.UUID
    status: ConnectorRunStatus
    started_at: datetime | None = None
    completed_at: datetime | None = None
    records_written: int = 0
    error_message: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
