"""Unit tests for packages.connector_sdk.base — BaseConnector ABC."""

from __future__ import annotations

import pytest
from packages.connector_sdk.base import BaseConnector


class _ConcreteConnector(BaseConnector):
    """Minimal concrete connector for testing the ABC contract."""

    provider = "test-provider"

    async def validate_credentials(self, credentials: dict) -> bool:
        return credentials.get("token") == "valid-token"

    async def collect(self, scope: dict) -> dict:
        return {"collected": True, "scope": scope}


@pytest.mark.unit()
def test_base_connector_cannot_be_instantiated_directly() -> None:
    """BaseConnector is abstract; direct instantiation must raise TypeError."""
    with pytest.raises(TypeError):
        BaseConnector()  # type: ignore[abstract]


@pytest.mark.unit()
def test_concrete_connector_can_be_instantiated() -> None:
    connector = _ConcreteConnector()
    assert connector.provider == "test-provider"


@pytest.mark.unit()
async def test_validate_credentials_valid_token() -> None:
    connector = _ConcreteConnector()
    result = await connector.validate_credentials({"token": "valid-token"})
    assert result is True


@pytest.mark.unit()
async def test_validate_credentials_invalid_token() -> None:
    connector = _ConcreteConnector()
    result = await connector.validate_credentials({"token": "wrong"})
    assert result is False


@pytest.mark.unit()
async def test_validate_credentials_empty_dict() -> None:
    connector = _ConcreteConnector()
    result = await connector.validate_credentials({})
    assert result is False


@pytest.mark.unit()
async def test_collect_returns_dict() -> None:
    connector = _ConcreteConnector()
    result = await connector.collect({"repos": ["org/repo"]})
    assert isinstance(result, dict)
    assert result["collected"] is True


@pytest.mark.unit()
async def test_collect_passes_scope_through() -> None:
    connector = _ConcreteConnector()
    scope = {"org": "my-org", "limit": 50}
    result = await connector.collect(scope)
    assert result["scope"] == scope


@pytest.mark.unit()
def test_concrete_connector_missing_method_raises() -> None:
    """A subclass that omits an abstract method must not be instantiable."""

    class _Incomplete(BaseConnector):
        provider = "incomplete"

        async def validate_credentials(self, credentials: dict) -> bool:
            return True

        # collect is intentionally missing

    with pytest.raises(TypeError):
        _Incomplete()  # type: ignore[abstract]
