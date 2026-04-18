"""Entry point for `python -m app.worker`."""

from __future__ import annotations

import asyncio

from app.worker import main

asyncio.run(main())
