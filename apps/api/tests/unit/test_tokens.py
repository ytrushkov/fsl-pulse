"""Unit tests for app.auth.tokens — JWT creation and decoding."""

from __future__ import annotations

from datetime import timedelta

import pytest
from jose import JWTError, jwt

from app.auth.tokens import create_access_token, decode_access_token


@pytest.fixture(autouse=True)
def _force_hs256(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Force HS256 + a known secret so token tests work regardless of the
    .env file (which may set JWT_ALGORITHM=RS256 requiring an RSA key).
    """
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("SECRET_KEY", "test-secret-for-unit-tests")
    # Clear lru_cache so the patched env is picked up.
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.mark.unit()
def test_create_access_token_returns_str() -> None:
    token = create_access_token({"sub": "user-123"})
    assert isinstance(token, str)
    assert len(token) > 0


@pytest.mark.unit()
def test_create_access_token_contains_sub() -> None:
    from app.config import get_settings

    token = create_access_token({"sub": "user-abc", "role": "assessor"})
    settings = get_settings()
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    assert payload["sub"] == "user-abc"
    assert payload["role"] == "assessor"


@pytest.mark.unit()
def test_create_access_token_includes_exp() -> None:
    from app.config import get_settings

    token = create_access_token({"sub": "user-x"})
    settings = get_settings()
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    assert "exp" in payload


@pytest.mark.unit()
def test_create_access_token_custom_expiry() -> None:
    """A custom expires_delta is respected."""
    from app.config import get_settings

    token = create_access_token({"sub": "user-y"}, expires_delta=timedelta(hours=24))
    settings = get_settings()
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    assert "exp" in payload


@pytest.mark.unit()
def test_decode_access_token_roundtrip() -> None:
    data = {"sub": "user-decode-test", "email": "test@example.com", "role": "admin"}
    token = create_access_token(data)
    decoded = decode_access_token(token)
    assert decoded["sub"] == "user-decode-test"
    assert decoded["email"] == "test@example.com"
    assert decoded["role"] == "admin"


@pytest.mark.unit()
def test_decode_access_token_invalid_raises() -> None:
    """Decoding a garbage token raises JWTError (jose)."""
    with pytest.raises(JWTError):
        decode_access_token("not.a.valid.token")


@pytest.mark.unit()
def test_decode_access_token_wrong_secret_raises() -> None:
    """A token signed with a different key must not decode successfully."""
    token = jwt.encode({"sub": "attacker"}, "wrong-secret", algorithm="HS256")
    with pytest.raises(JWTError):
        decode_access_token(token)


@pytest.mark.unit()
def test_create_access_token_expired_raises_on_decode() -> None:
    """Token with a negative expiry should fail validation."""
    token = create_access_token({"sub": "user-z"}, expires_delta=timedelta(seconds=-1))
    with pytest.raises(JWTError):
        decode_access_token(token)
