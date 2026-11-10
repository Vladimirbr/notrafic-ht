from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictStr

from app.geometry import IMAGE_HEIGHT, IMAGE_WIDTH, MAX_VERTICES, MIN_VERTICES, Point

X = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0, le=IMAGE_WIDTH)]
Y = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0, le=IMAGE_HEIGHT)]


def _parse_id(raw: object) -> int:
    if not isinstance(raw, str) or len(raw) > 10 or not raw.isascii() or not raw.isdecimal():
        raise ValueError("The polygon ID must be a positive integer.")
    return int(raw)


PolygonId = Annotated[int, Field(gt=0, le=2_147_483_647), BeforeValidator(_parse_id)]


class PolygonCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StrictStr
    points: Annotated[
        tuple[tuple[X, Y], ...], Field(min_length=MIN_VERTICES, max_length=MAX_VERTICES)
    ]


class PolygonResponse(BaseModel):
    id: int
    name: str
    points: tuple[Point, ...]


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
