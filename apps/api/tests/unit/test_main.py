"""Unit tests for app.main — create_app() factory."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.main import create_app


@pytest.mark.unit()
def test_create_app_returns_fastapi_instance() -> None:
    app = create_app()
    assert isinstance(app, FastAPI)


@pytest.mark.unit()
def test_create_app_title() -> None:
    app = create_app()
    assert app.title == "Pulse API"


@pytest.mark.unit()
def test_create_app_version() -> None:
    app = create_app()
    assert app.version == "0.1.0"


@pytest.mark.unit()
def test_create_app_docs_url_in_development(monkeypatch: pytest.MonkeyPatch) -> None:
    """docs_url is exposed in non-production environments."""
    monkeypatch.setenv("APP_ENV", "development")
    from app.config import get_settings

    get_settings.cache_clear()
    app = create_app()
    assert app.docs_url == "/docs"
    get_settings.cache_clear()


@pytest.mark.unit()
def test_create_app_docs_url_hidden_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """docs_url is None in production to avoid exposing the Swagger UI."""
    monkeypatch.setenv("APP_ENV", "production")
    from app.config import get_settings

    get_settings.cache_clear()
    app = create_app()
    assert app.docs_url is None
    get_settings.cache_clear()


@pytest.mark.unit()
def test_create_app_has_cors_middleware() -> None:
    app = create_app()
    middleware_types = [m.cls for m in app.user_middleware]
    assert CORSMiddleware in middleware_types


@pytest.mark.unit()
def test_create_app_health_route_registered() -> None:
    app = create_app()
    paths = [route.path for route in app.routes]
    assert "/health" in paths
