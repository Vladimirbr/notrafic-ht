import hashlib
import json
from typing import cast
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.contracts import ApiError, PolygonCreate, PolygonResponse
from app.database import CreationLedger, Polygon
from app.geometry import Point, normalize_name, validate_polygon


def _response(polygon: Polygon) -> PolygonResponse:
    return PolygonResponse(id=polygon.id, name=polygon.name, points=polygon.points)


def list_polygons(engine: Engine) -> list[PolygonResponse]:
    with Session(engine) as session:
        return [
            _response(polygon) for polygon in session.scalars(select(Polygon).order_by(Polygon.id))
        ]


def _fingerprint(name: str, points: tuple[Point, ...]) -> str:
    # The parsed coordinates are floats. Give both signs of zero the same representation.
    canonical = [(x or 0.0, y or 0.0) for x, y in points]
    data = json.dumps([name, canonical], separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _replay(session: Session, key: UUID, fingerprint: str) -> PolygonResponse:
    # A separate READ COMMITTED statement sees the winning transaction after a
    # conflict. The outer join reads the ledger and polygon in one snapshot.
    saved_fingerprint, joined_polygon = session.execute(
        select(CreationLedger.fingerprint, Polygon)
        .outerjoin(Polygon, Polygon.id == CreationLedger.polygon_id)
        .where(CreationLedger.key == key)
    ).one()
    if saved_fingerprint != fingerprint:
        raise ApiError(
            409, "idempotency_conflict", "This creation key was used with different input."
        )
    # SQLAlchemy's inferred type does not reflect the outer join's nullability.
    polygon = cast(Polygon | None, joined_polygon)
    if polygon is None:
        raise ApiError(
            410, "idempotency_result_deleted", "The previously created polygon was deleted."
        )
    return _response(polygon)


def create_polygon(
    engine: Engine, body: PolygonCreate, key: UUID | None
) -> tuple[PolygonResponse, bool]:
    try:
        name = normalize_name(body.name)
        validate_polygon(body.points)
    except ValueError as error:
        raise ApiError(422, "validation_error", str(error)) from error

    with Session(engine) as session, session.begin():
        if key is not None:
            fingerprint = _fingerprint(name, body.points)
            claimed = session.scalar(
                insert(CreationLedger)
                .values(key=key, fingerprint=fingerprint)
                .on_conflict_do_nothing(index_elements=[CreationLedger.key])
                .returning(CreationLedger.key)
            )
            if claimed is None:
                return _replay(session, key, fingerprint), False

        polygon = Polygon(name=name, points=body.points)
        session.add(polygon)
        session.flush()
        if key is not None:
            session.execute(
                update(CreationLedger)
                .where(CreationLedger.key == key)
                .values(polygon_id=polygon.id)
            )
        return _response(polygon), True


def delete_polygon(engine: Engine, polygon_id: int) -> None:
    with Session(engine) as session, session.begin():
        deleted = session.scalar(
            delete(Polygon).where(Polygon.id == polygon_id).returning(Polygon.id)
        )
        if deleted is None:
            raise ApiError(404, "polygon_not_found", "The polygon does not exist.")
