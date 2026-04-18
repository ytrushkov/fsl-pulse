"""Unit tests for the deliverables package (stub phase)."""

from __future__ import annotations

import pytest


@pytest.mark.unit()
def test_deliverables_package_importable() -> None:
    """The deliverables package must be importable without errors."""
    import packages.deliverables as pkg

    assert pkg is not None


@pytest.mark.unit()
def test_deliverables_package_has_docstring() -> None:
    import packages.deliverables as pkg

    assert pkg.__doc__ is not None
    assert len(pkg.__doc__) > 0
