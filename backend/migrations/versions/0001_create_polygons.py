"""Create polygons and the idempotency ledger."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.create_table(
        "polygons",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("points", JSONB(), nullable=False),
    )
    op.create_table(
        "creation_ledger",
        sa.Column("key", sa.Uuid(), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column(
            "polygon_id",
            sa.Integer(),
            sa.ForeignKey("polygons.id", ondelete="SET NULL"),
            unique=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("creation_ledger")
    op.drop_table("polygons")
