"""Unit tests for connector_sdk.base."""

from __future__ import annotations

import pytest
from packages.connector_sdk.base import BaseConnector

# ---------------------------------------------------------------------------
# Concrete minimal implementation used in tests
# ---------------------------------------------------------------------------


class _GoodConnector(BaseConnector):
    provider = "test_provider"

    async def validate_credentials(self, credentials: dict[str, str]) -> bool:
        return bool(credentials.get("token"))

    async def collect(self, scope: dict) -> dict:
        return {"rows": scope.get("limit", 0)}


class _AlwaysInvalidConnector(BaseConnector):
    provider = "invalid_provider"

    async def validate_credentials(self, credentials: dict[str, str]) -> bool:
        return False

    async def collect(self, scope: dict) -> dict:
        return {}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_base_connector_is_abstract() -> None:
    """BaseConnector cannot be instantiated directly."""
    with pytest.raises(TypeError):
        BaseConnector()  # type: ignore[abstract]


@pytest.mark.unit()
def test_concrete_connector_has_provider() -> None:
    connector = _GoodConnector()
    assert connector.provider == "test_provider"


@pytest.mark.unit()
async def test_validate_credentials_returns_true_with_token() -> None:
    connector = _GoodConnector()
    result = await connector.validate_credentials({"token": "abc123"})
    assert result is True


@pytest.mark.unit()
async def test_validate_credentials_returns_false_without_token() -> None:
    connector = _GoodConnector()
    result = await connector.validate_credentials({})
    assert result is False


@pytest.mark.unit()
async def test_collect_returns_dict() -> None:
    connector = _GoodConnector()
    result = await connector.collect({"limit": 10})
    assert isinstance(result, dict)
    assert result["rows"] == 10


@pytest.mark.unit()
async def test_collect_empty_scope() -> None:
    connector = _GoodConnector()
    result = await connector.collect({})
    assert result == {"rows": 0}


@pytest.mark.unit()
async def test_always_invalid_connector_validate() -> None:
    connector = _AlwaysInvalidConnector()
    result = await connector.validate_credentials({"token": "xyz"})
    assert result is False


@pytest.mark.unit()
async def test_always_invalid_connector_collect() -> None:
    connector = _AlwaysInvalidConnector()
    result = await connector.collect({"anything": True})
    assert result == {}


@pytest.mark.unit()
def test_missing_abstract_method_raises() -> None:
    """A class that forgets to implement collect cannot be instantiated."""

    class _Incomplete(BaseConnector):
        provider = "incomplete"

        async def validate_credentials(self, credentials: dict[str, str]) -> bool:
            return True

        # collect NOT implemented

    with pytest.raises(TypeError):
        _Incomplete()  # type: ignore[abstract]


@pytest.mark.unit()
def test_import_connector_sdk_package() -> None:
    """The top-level package must be importable."""
    import packages.connector_sdk as pkg

    assert pkg is not None
