import os
from dataclasses import dataclass
from math import isfinite

from sqlalchemy.engine import URL, make_url

DEFAULT_DATABASE_URL = "postgresql+psycopg://notraffic:notraffic-local@127.0.0.1:55432/notraffic"


@dataclass(frozen=True)
class Settings:
    database_url: str
    crud_delay_seconds: float

    @classmethod
    def from_environment(cls) -> Settings:
        delay = float(os.getenv("CRUD_DELAY_SECONDS", "5"))
        if not isfinite(delay) or delay < 0:
            raise ValueError("CRUD_DELAY_SECONDS must be finite and nonnegative.")
        return cls(os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL), delay)

    def sqlalchemy_url(self) -> URL:
        url = make_url(self.database_url)
        if url.drivername in {"postgresql", "postgres"}:
            return url.set(drivername="postgresql+psycopg")
        return url
