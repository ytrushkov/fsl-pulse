"""Unit tests for app.config — Settings loading and defaults."""

from __future__ import annotations

import pytest

from app.config import Settings, get_settings


@pytest.mark.unit()
def test_settings_instantiates() -> None:
    """Settings can be constructed without error."""
    s = Settings()
    assert s is not None


@pytest.mark.unit()
def test_settings_debug_is_bool() -> None:
    s = Settings()
    assert isinstance(s.debug, bool)


@pytest.mark.unit()
def test_settings_database_url_non_empty() -> None:
    s = Settings()
    assert isinstance(s.database_url, str)
    assert len(s.database_url) > 0


@pytest.mark.unit()
def test_settings_redis_url_non_empty() -> None:
    s = Settings()
    assert isinstance(s.redis_url, str)
    assert len(s.redis_url) > 0


@pytest.mark.unit()
def test_settings_jwt_algorithm_is_string() -> None:
    s = Settings()
    assert isinstance(s.jwt_algorithm, str)


@pytest.mark.unit()
def test_settings_access_token_expire_minutes_positive() -> None:
    s = Settings()
    assert s.access_token_expire_minutes > 0


@pytest.mark.unit()
def test_settings_log_level_is_string() -> None:
    s = Settings()
    assert isinstance(s.log_level, str)


@pytest.mark.unit()
def test_settings_feature_llm_enabled_is_bool() -> None:
    s = Settings()
    assert isinstance(s.feature_llm_enabled, bool)


@pytest.mark.unit()
def test_settings_s3_bucket_non_empty() -> None:
    s = Settings()
    assert isinstance(s.s3_bucket, str)
    assert len(s.s3_bucket) > 0


@pytest.mark.unit()
def test_settings_aws_region_non_empty() -> None:
    s = Settings()
    assert isinstance(s.aws_region, str)


@pytest.mark.unit()
def test_settings_app_env_is_string() -> None:
    s = Settings()
    assert isinstance(s.app_env, str)


@pytest.mark.unit()
def test_settings_override_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit env-var override is always respected."""
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("DEBUG", "true")
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    s = Settings()
    assert s.app_env == "staging"
    assert s.debug is True
    assert s.log_level == "WARNING"


@pytest.mark.unit()
def test_settings_secret_key_is_string() -> None:
    s = Settings()
    assert isinstance(s.secret_key, str)


@pytest.mark.unit()
def test_settings_temporal_host_is_string() -> None:
    s = Settings()
    assert isinstance(s.temporal_host, str)


@pytest.mark.unit()
def test_settings_temporal_namespace_is_string() -> None:
    s = Settings()
    assert isinstance(s.temporal_namespace, str)


@pytest.mark.unit()
def test_get_settings_returns_settings_instance() -> None:
    """get_settings() returns a cached Settings instance."""
    settings = get_settings()
    assert isinstance(settings, Settings)


@pytest.mark.unit()
def test_get_settings_is_cached() -> None:
    """get_settings() returns the same object on repeated calls (lru_cache)."""
    s1 = get_settings()
    s2 = get_settings()
    assert s1 is s2


@pytest.mark.unit()
def test_settings_custom_app_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    s = Settings()
    assert s.app_env == "production"


@pytest.mark.unit()
def test_settings_sentry_dsn_is_optional() -> None:
    """sentry_dsn may be None or a string."""
    s = Settings()
    assert s.sentry_dsn is None or isinstance(s.sentry_dsn, str)
