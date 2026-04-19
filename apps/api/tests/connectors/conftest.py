"""
Connector test conftest — vcrpy cassette configuration and auth scrubbing.

All connector HTTP calls MUST go through a vcrpy cassette.
Recording mode is controlled by the VCR_RECORD environment variable:

  VCR_RECORD=none   (default, CI) — replay only; fail if cassette missing
  VCR_RECORD=new_episodes         — record calls not yet in cassette
  VCR_RECORD=all                  — re-record everything (use to refresh)

Cassette naming convention:
  tests/fixtures/cassettes/<provider>/<test_function_name>.yaml

  Examples:
    tests/fixtures/cassettes/github/test_authenticate_returns_token.yaml
    tests/fixtures/cassettes/jira/test_collect_writes_records.yaml

Auth scrubbing is applied before every cassette write via the
before_record_request and before_record_response hooks. Real tokens are
replaced with 'REDACTED_TOKEN'. This scrub_patterns list must be extended
whenever a new connector uses a different auth header scheme.

Cassette serialization format: YAML (human-readable diffs in code review).
Do NOT use JSON — YAML diffs are far cleaner for cassette review.
"""

from __future__ import annotations

import os
import pathlib
import re

import pytest

# ---------------------------------------------------------------------------
# Cassette directory — single source of truth for all connector cassettes.
# ---------------------------------------------------------------------------
CASSETTE_DIR = pathlib.Path(__file__).parent.parent / "fixtures" / "cassettes"

VCR_RECORD_MODE = os.environ.get("VCR_RECORD", "none")


# ---------------------------------------------------------------------------
# Auth token scrubbing — applied before cassette writes.
# Covers Bearer tokens, Basic auth, GitHub PATs, GitLab tokens, API keys.
# ---------------------------------------------------------------------------
_REDACT_PLACEHOLDER = "REDACTED_TOKEN"

_SCRUB_HEADER_PATTERNS: list[re.Pattern] = [
    re.compile(r"^Authorization$", re.IGNORECASE),
    re.compile(r"^X-Api-Key$", re.IGNORECASE),
    re.compile(r"^Private-Token$", re.IGNORECASE),  # GitLab
    re.compile(r"^Atlassian-Token$", re.IGNORECASE),  # Jira
    re.compile(r"^Linear-Api-Key$", re.IGNORECASE),  # Linear
]


def _scrub_request(request):
    """Remove auth headers from recorded requests before cassette write."""
    for header_name in list(request.headers.keys()):
        for pattern in _SCRUB_HEADER_PATTERNS:
            if pattern.match(header_name):
                request.headers[header_name] = _REDACT_PLACEHOLDER
    return request


def _scrub_response(response):
    """
    Remove auth-adjacent data from recorded responses before cassette write.
    Access tokens in OAuth response bodies are replaced with the placeholder.
    """
    body_container = response.get("body", {})
    raw = body_container.get("string", b"")
    if isinstance(raw, bytes):
        body = raw.decode("utf-8", errors="replace")
        body = re.sub(
            r'"(access_token|token|refresh_token|client_secret)"\s*:\s*"[^"]+"',
            rf'"\1": "{_REDACT_PLACEHOLDER}"',
            body,
        )
        response["body"]["string"] = body.encode("utf-8")
    return response


# ---------------------------------------------------------------------------
# Shared vcrpy configuration — consumed by @pytest.mark.vcr and the
# pytest-recording plugin. Individual test modules may override specific
# keys by defining their own vcr_config fixture locally.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def vcr_config():
    """
    Session-scoped vcrpy configuration applied to every cassette in the
    connector test suite.

    match_on excludes the Authorization header from matching so tests replay
    correctly even though the cassette stores REDACTED_TOKEN.
    """
    return {
        "serializer": "yaml",
        "record_mode": VCR_RECORD_MODE,
        "match_on": ["method", "scheme", "host", "port", "path", "query"],
        "before_record_request": _scrub_request,
        "before_record_response": _scrub_response,
        "decode_compressed_response": True,
        "filter_query_parameters": ["access_token", "token", "api_key", "client_secret"],
        "filter_headers": [
            ("Authorization", _REDACT_PLACEHOLDER),
            ("X-Api-Key", _REDACT_PLACEHOLDER),
            ("Private-Token", _REDACT_PLACEHOLDER),
        ],
    }


@pytest.fixture(scope="session")
def cassette_dir() -> pathlib.Path:
    """Absolute path to the cassette root directory. Created if absent."""
    CASSETTE_DIR.mkdir(parents=True, exist_ok=True)
    return CASSETTE_DIR


# ---------------------------------------------------------------------------
# Fake connector credentials — used by conformance tests instead of real
# tokens. The autouse fake_kms from root conftest wraps these with a no-op
# encrypt/decrypt so the secret vault path is exercised without AWS calls.
# ---------------------------------------------------------------------------
@pytest.fixture()
def fake_github_credentials() -> dict:
    return {
        "token": "fake-kms:ghp_fake_github_pat_fixture_0000000000",
        "org": "fixture-org",
        "installation_id": None,
    }


@pytest.fixture()
def fake_gitlab_credentials() -> dict:
    return {
        "token": "fake-kms:glpat-fake_gitlab_token_fixture_00000",
        "base_url": "https://gitlab.com",
    }


@pytest.fixture()
def fake_jira_credentials() -> dict:
    return {
        "email": "fixture@example.com",
        "api_token": "fake-kms:jira_fake_token_fixture_0000000000",
        "base_url": "https://fixture.atlassian.net",
    }


@pytest.fixture()
def fake_linear_credentials() -> dict:
    return {
        "api_key": "fake-kms:lin_api_fake_linear_key_fixture_0000",
    }
