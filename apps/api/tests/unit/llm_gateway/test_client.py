"""Unit tests for packages.llm_gateway.client — GatewayClient and helpers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import packages.llm_gateway.client as gateway_module
import pytest
from packages.llm_gateway.client import (
    CompletionResult,
    GatewayClient,
    get_gateway,
    init_gateway,
)


@pytest.mark.unit()
def test_completion_result_dataclass() -> None:
    usage = MagicMock(input_tokens=10, output_tokens=5)
    result = CompletionResult(
        content="hello",
        model="claude-sonnet-4-6",
        usage=usage,
        prompt_hash="sha256:abc",
        response_hash="sha256:def",
    )
    assert result.content == "hello"
    assert result.model == "claude-sonnet-4-6"
    assert result.prompt_hash == "sha256:abc"
    assert result.response_hash == "sha256:def"


@pytest.mark.unit()
def test_gateway_client_init_stores_api_key() -> None:
    client = GatewayClient(api_key="test-key-123")
    assert client._api_key == "test-key-123"


@pytest.mark.unit()
def test_gateway_client_init_default_model() -> None:
    client = GatewayClient(api_key="test-key")
    assert client._default_model == "claude-sonnet-4-6"


@pytest.mark.unit()
def test_gateway_client_init_custom_model() -> None:
    client = GatewayClient(api_key="test-key", default_model="claude-opus-4-6")
    assert client._default_model == "claude-opus-4-6"


@pytest.mark.unit()
def test_init_gateway_sets_global_client() -> None:
    original = gateway_module._gateway_client
    try:
        init_gateway("my-api-key")
        assert gateway_module._gateway_client is not None
        assert isinstance(gateway_module._gateway_client, GatewayClient)
    finally:
        gateway_module._gateway_client = original


@pytest.mark.unit()
def test_get_gateway_raises_when_not_initialized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gateway_module, "_gateway_client", None)
    with pytest.raises(RuntimeError, match="not initialized"):
        get_gateway()


@pytest.mark.unit()
def test_get_gateway_returns_client_when_initialized() -> None:
    fake_client = MagicMock(spec=GatewayClient)
    original = gateway_module._gateway_client
    try:
        gateway_module._gateway_client = fake_client
        result = get_gateway()
        assert result is fake_client
    finally:
        gateway_module._gateway_client = original


@pytest.mark.unit()
async def test_gateway_client_complete_calls_anthropic() -> None:
    """GatewayClient.complete constructs a CompletionResult from the SDK response."""
    fake_text_block = MagicMock()
    fake_text_block.text = "answer text"

    fake_response = MagicMock()
    fake_response.content = [fake_text_block]
    fake_response.usage.input_tokens = 20
    fake_response.usage.output_tokens = 10

    with patch("anthropic.AsyncAnthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_client.messages.create = AsyncMock(return_value=fake_response)
        mock_anthropic_cls.return_value = mock_client

        client = GatewayClient(api_key="test")
        result = await client.complete(
            system="You are a helper",
            messages=[{"role": "user", "content": "What is 2+2?"}],
        )

    assert isinstance(result, CompletionResult)
    assert result.content == "answer text"
    assert result.model == "claude-sonnet-4-6"
    assert result.prompt_hash.startswith("sha256:")
    assert result.response_hash.startswith("sha256:")


@pytest.mark.unit()
async def test_gateway_client_complete_uses_custom_model() -> None:
    fake_text_block = MagicMock()
    fake_text_block.text = "custom model answer"

    fake_response = MagicMock()
    fake_response.content = [fake_text_block]
    fake_response.usage.input_tokens = 5
    fake_response.usage.output_tokens = 3

    with patch("anthropic.AsyncAnthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_client.messages.create = AsyncMock(return_value=fake_response)
        mock_anthropic_cls.return_value = mock_client

        client = GatewayClient(api_key="test")
        result = await client.complete(
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
            model="claude-haiku",
        )

    assert result.model == "claude-haiku"


@pytest.mark.unit()
async def test_gateway_client_complete_empty_content() -> None:
    """If Anthropic returns an empty content list, content defaults to empty string."""
    fake_response = MagicMock()
    fake_response.content = []
    fake_response.usage.input_tokens = 1
    fake_response.usage.output_tokens = 0

    with patch("anthropic.AsyncAnthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_client.messages.create = AsyncMock(return_value=fake_response)
        mock_anthropic_cls.return_value = mock_client

        client = GatewayClient(api_key="test")
        result = await client.complete(system="sys", messages=[])

    assert result.content == ""
