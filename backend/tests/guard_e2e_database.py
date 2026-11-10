"""Verify the effective PostgreSQL database before E2E migrations or resets."""

import os

from sqlalchemy import create_engine, text

from app.settings import Settings


def verify_e2e_database(database_url: str) -> None:
    url = Settings(database_url, 0).sqlalchemy_url()
    expected = url.database
    if url.get_backend_name() != "postgresql" or not (expected or "").endswith("_browser_test"):
        raise ValueError(
            "E2E_DATABASE_URL must name a disposable PostgreSQL _browser_test database."
        )

    engine = create_engine(url, connect_args={"connect_timeout": 2})
    try:
        with engine.connect() as connection:
            if connection.scalar(text("SELECT current_database()")) != expected:
                raise ValueError("PostgreSQL connected to a different database than specified.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    verify_e2e_database(os.environ["E2E_DATABASE_URL"])
