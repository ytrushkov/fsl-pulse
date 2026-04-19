"""Unit tests for the /health endpoint — no DB, no external services."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture(scope="module")
def sync_client() -> TestClient:
    """Synchronous TestClient; avoids the need for a running DB."""
    return TestClient(create_app(), raise_server_exceptions=True)


@pytest.mark.unit()
def test_health_status_ok(sync_client: TestClient) -> None:
    response = sync_client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.unit()
def test_health_version_present(sync_client: TestClient) -> None:
    response = sync_client.get("/health")
    assert "version" in response.json()
    assert response.json()["version"] == "0.1.0"


@pytest.mark.unit()
def test_health_content_type_json(sync_client: TestClient) -> None:
    response = sync_client.get("/health")
    assert "application/json" in response.headers["content-type"]


@pytest.mark.unit()
def test_health_response_schema(sync_client: TestClient) -> None:
    """Response must match HealthResponse schema: status and version keys only."""
    body = sync_client.get("/health").json()
    assert set(body.keys()) == {"status", "version"}
