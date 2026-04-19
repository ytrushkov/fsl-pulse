"""Rebuild Pydantic models that have forward-ref fields due to PEP 563 annotations."""

from __future__ import annotations

import datetime
import uuid

from packages.shared_models.engagement import (
    EngagementBase,
    EngagementCreate,
    EngagementRead,
)

_NS = {"date": datetime.date, "datetime": datetime.datetime, "uuid": uuid}

EngagementBase.model_rebuild(_types_namespace=_NS)
EngagementCreate.model_rebuild(_types_namespace=_NS)
EngagementRead.model_rebuild(_types_namespace=_NS)
