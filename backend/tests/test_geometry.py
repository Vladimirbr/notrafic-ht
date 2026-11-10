import json
from pathlib import Path

import pytest
from pydantic import BaseModel, TypeAdapter

from app.geometry import Point, normalize_name, validate_polygon

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


class GeometryCase(BaseModel):
    case: str
    points: tuple[Point, ...]
    valid: bool


class NameCase(BaseModel):
    input: str
    output: str | None


@pytest.mark.parametrize(
    "case",
    TypeAdapter(list[GeometryCase]).validate_python(
        json.loads((FIXTURES / "geometry.json").read_text(encoding="utf-8"))
    ),
    ids=lambda case: case.case,
)
def test_simple_contour(case: GeometryCase) -> None:
    if case.valid:
        validate_polygon(case.points)
    else:
        with pytest.raises(ValueError):
            validate_polygon(case.points)


@pytest.mark.parametrize(
    "case",
    TypeAdapter(list[NameCase]).validate_python(
        json.loads((FIXTURES / "names.json").read_text(encoding="utf-8"))
    ),
)
def test_shared_name_rules(case: NameCase) -> None:
    if case.output is None:
        with pytest.raises(ValueError):
            normalize_name(case.input)
    else:
        assert normalize_name(case.input) == case.output


def test_counts_code_points_instead_of_utf16_units() -> None:
    assert normalize_name("🚗" * 100) == "🚗" * 100
    with pytest.raises(ValueError):
        normalize_name("🚗" * 101)
