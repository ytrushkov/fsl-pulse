"""Unit tests for scoring.engine."""

from __future__ import annotations

import pytest
from packages.scoring.engine import (
    DIMENSIONS,
    MATURITY_LEVELS,
    score_dimension,
    score_engagement,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_dimensions_is_list_of_six() -> None:
    assert isinstance(DIMENSIONS, list)
    assert len(DIMENSIONS) == 6


@pytest.mark.unit()
def test_dimensions_contains_expected_names() -> None:
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
def test_maturity_levels_values() -> None:
    assert MATURITY_LEVELS[1] == "Initial"
    assert MATURITY_LEVELS[2] == "Developing"
    assert MATURITY_LEVELS[3] == "Defined"
    assert MATURITY_LEVELS[4] == "Managed"
    assert MATURITY_LEVELS[5] == "Optimizing"


# ---------------------------------------------------------------------------
# score_dimension
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_score_dimension_returns_int() -> None:
    result = score_dimension("strategy_governance", {})
    assert isinstance(result, int)


@pytest.mark.unit()
def test_score_dimension_within_valid_range() -> None:
    for dim in DIMENSIONS:
        result = score_dimension(dim, {"some": "evidence"})
        assert 1 <= result <= 5, f"dimension {dim!r} returned out-of-range score {result}"


@pytest.mark.unit()
def test_score_dimension_stub_returns_one() -> None:
    """The placeholder implementation always returns 1."""
    for dim in DIMENSIONS:
        assert score_dimension(dim, {}) == 1


@pytest.mark.unit()
def test_score_dimension_accepts_arbitrary_evidence() -> None:
    result = score_dimension("data_quality", {"key": "value", "count": 42})
    assert result == 1


@pytest.mark.unit()
def test_score_dimension_unknown_dimension_does_not_raise() -> None:
    result = score_dimension("not_a_real_dimension", {})
    assert isinstance(result, int)


# ---------------------------------------------------------------------------
# score_engagement
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_score_engagement_returns_dict() -> None:
    result = score_engagement({})
    assert isinstance(result, dict)


@pytest.mark.unit()
def test_score_engagement_keys_are_all_dimensions() -> None:
    result = score_engagement({})
    assert set(result.keys()) == set(DIMENSIONS)


@pytest.mark.unit()
def test_score_engagement_all_values_are_ints() -> None:
    result = score_engagement({})
    for dim, score in result.items():
        assert isinstance(score, int), f"Expected int for {dim!r}, got {type(score)}"


@pytest.mark.unit()
def test_score_engagement_with_evidence() -> None:
    evidence = {
        "strategy_governance": {"maturity": "high"},
        "data_quality": {"completeness": 0.95},
    }
    result = score_engagement(evidence)
    assert set(result.keys()) == set(DIMENSIONS)
    for score in result.values():
        assert 1 <= score <= 5


@pytest.mark.unit()
def test_score_engagement_missing_dimensions_default_to_empty() -> None:
    """Dimensions absent from the input still produce a score."""
    result = score_engagement({"strategy_governance": {"x": 1}})
    for dim in DIMENSIONS:
        assert dim in result


@pytest.mark.unit()
def test_score_engagement_stub_all_ones() -> None:
    result = score_engagement({})
    for dim in DIMENSIONS:
        assert result[dim] == 1


@pytest.mark.unit()
def test_scoring_package_importable() -> None:
    import packages.scoring as pkg

    assert pkg is not None
