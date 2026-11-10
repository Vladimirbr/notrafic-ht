import pytest

from app.settings import DEFAULT_DATABASE_URL, Settings


def test_default_settings_point_to_local_development_postgres(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("CRUD_DELAY_SECONDS", raising=False)
    settings = Settings.from_environment()
    assert settings.database_url == DEFAULT_DATABASE_URL
    assert settings.crud_delay_seconds == 5


@pytest.mark.parametrize("url", ["postgresql://user@localhost/db", "postgres://user@localhost/db"])
def test_environment_uses_bundled_psycopg_driver(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("CRUD_DELAY_SECONDS", "0.025")
    settings = Settings.from_environment()
    assert settings.sqlalchemy_url().drivername == "postgresql+psycopg"
    assert settings.crud_delay_seconds == 0.025


@pytest.mark.parametrize("delay", ["-1", "nan", "Infinity", "invalid"])
def test_environment_rejects_an_invalid_delay(delay: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRUD_DELAY_SECONDS", delay)
    with pytest.raises(ValueError):
        Settings.from_environment()
