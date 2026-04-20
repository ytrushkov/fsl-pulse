"""Round-trip tests for the Assessment Pydantic schema against fixture files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.assessment import Assessment

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures" / "assessments"


def _load(filename: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads((FIXTURES_DIR / filename).read_text())
    return result


# ---------------------------------------------------------------------------
# Parsing tests
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_minimal_parses_without_error() -> None:
    data = _load("minimal.json")
    a = Assessment.model_validate(data)
    assert a.engagement.client == "AcmeCorp"
    assert a.scores is None
    assert a.deliverables is None
    assert a.provenance is None


@pytest.mark.unit()
def test_scored_parses_without_error() -> None:
    data = _load("scored.json")
    a = Assessment.model_validate(data)
    assert a.engagement.client == "BetaSoft"
    assert a.scores is not None
    assert len(a.scores.by_dimension) == 6
    assert a.deliverables is None


@pytest.mark.unit()
def test_complete_parses_without_error() -> None:
    data = _load("complete.json")
    a = Assessment.model_validate(data)
    assert a.engagement.client == "GammaWorks"
    assert a.scores is not None
    assert a.deliverables is not None
    assert a.provenance is not None


# ---------------------------------------------------------------------------
# Round-trip (parse → serialize → re-parse) tests
# ---------------------------------------------------------------------------


@pytest.mark.unit()
@pytest.mark.parametrize("filename", ["minimal.json", "scored.json", "complete.json"])
def test_round_trip_is_stable(filename: str) -> None:
    """Serialize then re-parse must produce an identical object."""
    original = Assessment.model_validate(_load(filename))
    serialized = original.model_dump(mode="json")
    restored = Assessment.model_validate(serialized)
    assert original == restored


# ---------------------------------------------------------------------------
# Dimension coverage
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_complete_has_all_six_dimensions() -> None:
    a = Assessment.model_validate(_load("complete.json"))
    expected = {"tooling", "measurement", "process", "people", "governance", "culture"}
    assert set(a.dimensions.keys()) == expected


@pytest.mark.unit()
def test_scored_dimension_scores_in_range() -> None:
    a = Assessment.model_validate(_load("scored.json"))
    assert a.scores is not None
    for dim, rec in a.scores.by_dimension.items():
        assert 0 <= rec.score <= 100, f"{dim} score out of range"
        assert 1 <= rec.stage <= 5, f"{dim} stage out of range"


# ---------------------------------------------------------------------------
# Systems
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_minimal_has_two_vcs_systems() -> None:
    a = Assessment.model_validate(_load("minimal.json"))
    assert len(a.systems.vcs) == 2


@pytest.mark.unit()
def test_complete_has_two_ai_tooling_systems() -> None:
    a = Assessment.model_validate(_load("complete.json"))
    assert len(a.systems.ai_tooling) == 2


# ---------------------------------------------------------------------------
# Deliverables (complete fixture)
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_complete_npv_base_scenario() -> None:
    a = Assessment.model_validate(_load("complete.json"))
    assert a.deliverables is not None
    assert a.deliverables.npv is not None
    assert "base" in a.deliverables.npv.scenarios
    base = a.deliverables.npv.scenarios["base"]
    assert base.npv_3yr == pytest.approx(2_180_000.0)
    assert base.payback_months == pytest.approx(8.2)


@pytest.mark.unit()
def test_complete_action_plan_has_three_items() -> None:
    a = Assessment.model_validate(_load("complete.json"))
    assert a.deliverables is not None
    assert len(a.deliverables.action_plan) == 3


@pytest.mark.unit()
def test_complete_pdlc_entry_point() -> None:
    a = Assessment.model_validate(_load("complete.json"))
    assert a.deliverables is not None
    assert a.deliverables.pdlc_entry_point is not None
    assert a.deliverables.pdlc_entry_point.recommended_stage == "build"


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_scored_evidence_signal_types_are_valid() -> None:
    a = Assessment.model_validate(_load("scored.json"))
    valid = {"strength", "gap", "risk", "quote", "context"}
    for dim, dim_data in a.dimensions.items():
        for ev in dim_data.evidence:
            assert ev.signal_type in valid, f"Bad signal_type in {dim}"


# ---------------------------------------------------------------------------
# Validation rejection
# ---------------------------------------------------------------------------


@pytest.mark.unit()
def test_missing_engagement_raises_validation_error() -> None:
    data = _load("minimal.json")
    del data["engagement"]
    with pytest.raises(ValidationError):
        Assessment.model_validate(data)


@pytest.mark.unit()
def test_invalid_score_out_of_range_raises() -> None:
    data = _load("scored.json")
    data["scores"]["by_dimension"]["tooling"]["score"] = 150
    with pytest.raises(ValidationError):
        Assessment.model_validate(data)


@pytest.mark.unit()
def test_invalid_stage_out_of_range_raises() -> None:
    data = _load("scored.json")
    data["scores"]["by_dimension"]["tooling"]["stage"] = 0
    with pytest.raises(ValidationError):
        Assessment.model_validate(data)
