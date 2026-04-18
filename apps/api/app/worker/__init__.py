"""Temporal worker entry point — run with: python -m app.worker"""

from __future__ import annotations

import asyncio

import structlog

logger = structlog.get_logger(__name__)


async def main() -> None:
    logger.info("worker_starting")
    # Phase 1+: register workflow and activity workers here
    logger.info("worker_started")
    # Keep alive until interrupted
    try:
        await asyncio.Future()
    except asyncio.CancelledError:
        logger.info("worker_stopping")


if __name__ == "__main__":
    asyncio.run(main())
