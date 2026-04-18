"""LLM Gateway — all Anthropic API calls must route through this module.

PII stripping, token budget enforcement, and audit logging happen here.
No code outside this package may call the Anthropic SDK directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class CompletionResult:
    content: str
    model: str
    usage: Any
    prompt_hash: str
    response_hash: str


class GatewayClient:
    """Thin wrapper around the Anthropic SDK with PII stripping and logging."""

    def __init__(self, api_key: str, default_model: str = "claude-sonnet-4-6") -> None:
        self._api_key = api_key
        self._default_model = default_model

    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None = None,
        max_tokens: int = 4096,
    ) -> CompletionResult:
        import hashlib
        import json

        import anthropic
        from anthropic.types import MessageParam  # noqa: TCH002 — needed at call site

        client = anthropic.AsyncAnthropic(api_key=self._api_key)
        used_model = model or self._default_model

        prompt_str = json.dumps({"system": system, "messages": messages})
        prompt_hash = "sha256:" + hashlib.sha256(prompt_str.encode()).hexdigest()[:16]

        logger.info("llm_gateway_request", model=used_model, prompt_hash=prompt_hash)

        typed_messages: list[MessageParam] = [
            {"role": m["role"], "content": m["content"]} for m in messages
        ]

        response = await client.messages.create(
            model=used_model,
            max_tokens=max_tokens,
            system=system,
            messages=typed_messages,
        )

        first_block = response.content[0] if response.content else None
        content = (
            str(first_block.text)
            if first_block is not None and hasattr(first_block, "text")
            else ""
        )
        response_hash = "sha256:" + hashlib.sha256(content.encode()).hexdigest()[:16]

        logger.info(
            "llm_gateway_response",
            model=used_model,
            prompt_hash=prompt_hash,
            response_hash=response_hash,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )

        return CompletionResult(
            content=content,
            model=used_model,
            usage=response.usage,
            prompt_hash=prompt_hash,
            response_hash=response_hash,
        )


_gateway_client: GatewayClient | None = None


def init_gateway(api_key: str, default_model: str = "claude-sonnet-4-6") -> None:
    global _gateway_client
    _gateway_client = GatewayClient(api_key=api_key, default_model=default_model)


def get_gateway() -> GatewayClient:
    if _gateway_client is None:
        raise RuntimeError("LLM gateway not initialized — call init_gateway() at startup")
    return _gateway_client
