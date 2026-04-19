from __future__ import annotations

from typing import Any

DIMENSIONS = [
    "strategy_governance",
    "tooling_infrastructure",
    "team_practices",
    "data_quality",
    "security_compliance",
    "change_management",
]

MATURITY_LEVELS = {1: "Initial", 2: "Developing", 3: "Defined", 4: "Managed", 5: "Optimizing"}


def score_dimension(dimension: str, evidence: dict[str, Any]) -> int:
    """Return a maturity level (1-5) for a single dimension. Placeholder implementation."""
    return 1


def score_engagement(evidence_by_dimension: dict[str, dict[str, Any]]) -> dict[str, int]:
    return {dim: score_dimension(dim, evidence_by_dimension.get(dim, {})) for dim in DIMENSIONS}
