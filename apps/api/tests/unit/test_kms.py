"""Unit tests for app.secrets.kms — KMS client protocol and fake."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import app.secrets.kms as kms_module
from app.secrets.kms import _DefaultKMSClient


@pytest.mark.unit()
def test_kms_protocol_encrypt_decrypt_via_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    """The fake_kms autouse fixture replaces _client; verify encrypt/decrypt."""
    # fake_kms is already applied by autouse — just call through the module attribute.
    result = kms_module._client.encrypt("hello")
    assert result == "fake-kms:hello"

    recovered = kms_module._client.decrypt("fake-kms:hello")
    assert recovered == "hello"


@pytest.mark.unit()
def test_kms_fake_encrypt_returns_prefixed_string(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = MagicMock()
    fake.encrypt = MagicMock(side_effect=lambda p: f"fake-kms:{p}")
    monkeypatch.setattr(kms_module, "_client", fake)
    assert kms_module._client.encrypt("secret") == "fake-kms:secret"


@pytest.mark.unit()
def test_kms_fake_decrypt_strips_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = MagicMock()
    fake.decrypt = MagicMock(side_effect=lambda c: c.removeprefix("fake-kms:"))
    monkeypatch.setattr(kms_module, "_client", fake)
    assert kms_module._client.decrypt("fake-kms:my-secret") == "my-secret"


@pytest.mark.unit()
def test_kms_protocol_satisfied_by_default_client() -> None:
    """_DefaultKMSClient must have encrypt and decrypt callables."""
    client = _DefaultKMSClient()
    assert callable(client.encrypt)
    assert callable(client.decrypt)


@pytest.mark.unit()
def test_kms_client_attribute_is_set() -> None:
    """Module-level _client is initialized at import time."""
    assert kms_module._client is not None
