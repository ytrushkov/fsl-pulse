from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseConnector(ABC):
    """All connectors must implement this interface."""

    provider: str

    @abstractmethod
    async def validate_credentials(self, credentials: dict[str, str]) -> bool: ...

    @abstractmethod
    async def collect(self, scope: dict[str, Any]) -> dict[str, Any]: ...
