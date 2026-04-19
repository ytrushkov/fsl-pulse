"""Unit tests for packages.scoring.engine — scoring functions."""

from __future__ import annotations

import pytest
from packages.scoring.engine import (
    DIMENSIONS,
    MATURITY_LEVELS,
    score_dimension,
    score_engagement,
)


@pytest.mark.unit()
def test_dimensions_list_not_empty() -> None:
    assert len(DIMENSIONS) > 0


@pytest.mark.unit()
def test_dimensions_list_has_expected_entries() -> None:
    expected = {
        "strategy_governance",
        "tooling_infrastructure",
        "team_practices",
        "data_quality",
        "security_compliance",
        "change_management",
    }
    assert set(DIMENSIONS) == expected


@pytest.mark.unit()
def test_maturity_levels_keys() -> None:
    assert set(MATURITY_LEVELS.keys()) == {1, 2, 3, 4, 5}


@pytest.mark.unit()
def test_maturity_levels_values_are_strings() -> None:
    for v in MATURITY_LEVELS.values():
        assert isinstance(v, str)


@pytest.mark.unit()
def test_score_dimension_returns_int() -> None:
    result = score_dimension("strategy_governance", {})
    assert isinstance(result, int)


@pytest.mark.unit()
def test_score_dimension_returns_value_in_range() -> None:
    for dim in DIMENSIONS:
        score = score_dimension(dim, {"some": "evidence"})
        assert 1 <= score <= 5, f"Score for {dim} out of range: {score}"


@pytest.mark.unit()
def test_score_dimension_unknown_dimension() -> None:
    """score_dimension should not raise on unknown dimension names."""
    result = score_dimension("nonexistent_dimension", {})
    assert isinstance(result, int)


@pytest.mark.unit()
def test_score_engagement_returns_dict_for_all_dimensions() -> None:
    evidence = {dim: {} for dim in DIMENSIONS}
    result = score_engagement(evidence)
    assert set(result.keys()) == set(DIMENSIONS)


@pytest.mark.unit()
def test_score_engagement_all_values_are_ints() -> None:
    result = score_engagement({})
    for dim, score in result.items():
        assert isinstance(score, int), f"Non-int score for {dim}"


@pytest.mark.unit()
def test_score_engagement_empty_evidence_uses_defaults() -> None:
    """score_engagement with no evidence should not raise."""
    result = score_engagement({})
    assert len(result) == len(DIMENSIONS)


@pytest.mark.unit()
def test_score_engagement_partial_evidence() -> None:
    """Partial evidence dict should still produce scores for all dimensions."""
    partial = {"strategy_governance": {"maturity": 3}}
    result = score_engagement(partial)
    assert set(result.keys()) == set(DIMENSIONS)


@pytest.mark.unit()
def test_score_engagement_values_in_valid_range() -> None:
    result = score_engagement({})
    for score in result.values():
        assert 1 <= score <= 5
