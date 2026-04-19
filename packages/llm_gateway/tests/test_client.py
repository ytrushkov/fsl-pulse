"""Unit tests for llm_gateway.client (Anthropic SDK mocked out)."""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from packages.llm_gateway.client import (
    CompletionResult,
    GatewayClient,
    get_gateway,
    init_gateway,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_response(text: str = "Hello, world!") -> MagicMock:
    """Build a fake anthropic.types.Message-like object."""
    content_block = SimpleNamespace(text=text)
    usage = SimpleNamespace(input_tokens=10, output_tokens=5)
    return SimpleNamespace(content=[content_block], usage=usage)


# ---------------------------------------------------------------------------
# CompletionResult dataclass
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_completion_result_fields() -> None:
    result = CompletionResult(
        content="hi",
        model="claude-sonnet-4-6",
        usage=None,
        prompt_hash="sha256:abc",
        response_hash="sha256:def",
    )
    assert result.content == "hi"
    assert result.model == "claude-sonnet-4-6"
    assert result.prompt_hash == "sha256:abc"
    assert result.response_hash == "sha256:def"


# ---------------------------------------------------------------------------
# GatewayClient construction
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_gateway_client_stores_api_key() -> None:
    client = GatewayClient(api_key="test-key")
    assert client._api_key == "test-key"


@pytest.mark.unit()
def test_gateway_client_default_model() -> None:
    client = GatewayClient(api_key="key")
    assert client._default_model == "claude-sonnet-4-6"


@pytest.mark.unit()
def test_gateway_client_custom_model() -> None:
    client = GatewayClient(api_key="key", default_model="claude-opus-4-6")
    assert client._default_model == "claude-opus-4-6"


# ---------------------------------------------------------------------------
# GatewayClient.complete — happy path
# ---------------------------------------------------------------------------


@pytest.mark.unit()
async def test_complete_returns_completion_result() -> None:
    fake_response = _make_fake_response("The answer is 42.")
    mock_anthropic_client = MagicMock()
    mock_anthropic_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_anthropic_client):
        client = GatewayClient(api_key="test-key")
        result = await client.complete(
            system="You are helpful.",
            messages=[{"role": "user", "content": "What is the answer?"}],
        )

    assert isinstance(result, CompletionResult)
    assert result.content == "The answer is 42."
    assert result.model == "claude-sonnet-4-6"


@pytest.mark.unit()
async def test_complete_uses_explicit_model() -> None:
    fake_response = _make_fake_response("ok")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        result = await gateway.complete(
            system="sys",
            messages=[],
            model="claude-haiku-4-6",
        )

    assert result.model == "claude-haiku-4-6"
    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == "claude-haiku-4-6"


@pytest.mark.unit()
async def test_complete_prompt_hash_format() -> None:
    fake_response = _make_fake_response("result")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    system = "sys prompt"
    messages = [{"role": "user", "content": "hello"}]

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        result = await gateway.complete(system=system, messages=messages)

    expected_raw = json.dumps({"system": system, "messages": messages})
    expected_hash = "sha256:" + hashlib.sha256(expected_raw.encode()).hexdigest()[:16]
    assert result.prompt_hash == expected_hash


@pytest.mark.unit()
async def test_complete_response_hash_format() -> None:
    content_text = "response content"
    fake_response = _make_fake_response(content_text)
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        result = await gateway.complete(system="s", messages=[])

    expected_hash = "sha256:" + hashlib.sha256(content_text.encode()).hexdigest()[:16]
    assert result.response_hash == expected_hash


@pytest.mark.unit()
async def test_complete_usage_attached() -> None:
    fake_response = _make_fake_response("x")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        result = await gateway.complete(system="s", messages=[])

    assert result.usage is fake_response.usage


@pytest.mark.unit()
async def test_complete_empty_content_list() -> None:
    """When response.content is empty the result content should be an empty string."""
    fake_response = SimpleNamespace(
        content=[],
        usage=SimpleNamespace(input_tokens=1, output_tokens=0),
    )
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        result = await gateway.complete(system="s", messages=[])

    assert result.content == ""


@pytest.mark.unit()
async def test_complete_passes_max_tokens() -> None:
    fake_response = _make_fake_response("ok")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        gateway = GatewayClient(api_key="key")
        await gateway.complete(system="s", messages=[], max_tokens=512)

    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["max_tokens"] == 512


# ---------------------------------------------------------------------------
# Module-level init_gateway / get_gateway
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_get_gateway_raises_before_init() -> None:
    import packages.llm_gateway.client as mod

    original = mod._gateway_client
    mod._gateway_client = None
    try:
        with pytest.raises(RuntimeError, match="not initialized"):
            get_gateway()
    finally:
        mod._gateway_client = original


@pytest.mark.unit()
def test_init_gateway_sets_client() -> None:
    import packages.llm_gateway.client as mod

    original = mod._gateway_client
    try:
        init_gateway("my-api-key", default_model="claude-haiku-4-6")
        gw = get_gateway()
        assert isinstance(gw, GatewayClient)
        assert gw._api_key == "my-api-key"
        assert gw._default_model == "claude-haiku-4-6"
    finally:
        mod._gateway_client = original


@pytest.mark.unit()
def test_init_gateway_default_model() -> None:
    import packages.llm_gateway.client as mod

    original = mod._gateway_client
    try:
        init_gateway("key")
        gw = get_gateway()
        assert gw._default_model == "claude-sonnet-4-6"
    finally:
        mod._gateway_client = original


@pytest.mark.unit()
def test_llm_gateway_package_importable() -> None:
    import packages.llm_gateway as pkg

    assert pkg is not None
