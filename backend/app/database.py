from uuid import UUID

from sqlalchemy import ForeignKey, Identity, String, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.geometry import Point


class Base(DeclarativeBase):
    pass


class Polygon(Base):
    __tablename__ = "polygons"

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    points: Mapped[tuple[Point, ...]] = mapped_column(JSONB)


class CreationLedger(Base):
    __tablename__ = "creation_ledger"

    key: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    polygon_id: Mapped[int | None] = mapped_column(
        ForeignKey("polygons.id", ondelete="SET NULL"), unique=True
    )
