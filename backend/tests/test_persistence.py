import asyncio
import os
import socket
import subprocess
import sys
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from time import monotonic, sleep
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient, Client, ConnectError, Response, TimeoutException
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url

from app.main import create_app
from app.settings import Settings
from tests.guard_e2e_database import verify_e2e_database

pytestmark = pytest.mark.integration
POLYGONS = "/api/polygons"
BODY = {"name": "  \ufeffLane 🚗\x85", "points": [[0, 0], [1920, 0], [0.125, 1080]]}


def _test_database_url() -> str:
    if url := os.getenv("TEST_DATABASE_URL"):
        return url
    port = os.getenv("TEST_POSTGRES_PORT") or "55433"
    return f"postgresql+psycopg://notraffic:notraffic-local@127.0.0.1:{port}/notraffic_test"


def test_default_database_url_follows_compose_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    monkeypatch.setenv("TEST_POSTGRES_PORT", "65433")
    assert make_url(_test_database_url()).port == 65433


def test_database_url_override_takes_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    override = "postgresql+psycopg://user@localhost:65434/override_test"
    monkeypatch.setenv("TEST_DATABASE_URL", override)
    monkeypatch.setenv("TEST_POSTGRES_PORT", "65433")
    assert _test_database_url() == override


@pytest.fixture(scope="module")
def migrated_db() -> Iterator[Engine]:
    url = _test_database_url()
    parsed = make_url(url)
    if parsed.get_backend_name() != "postgresql" or not (parsed.database or "").endswith("_test"):
        pytest.fail(
            "TEST_DATABASE_URL must point to a disposable PostgreSQL database ending in _test."
        )
    engine = create_engine(Settings(url, 0).sqlalchemy_url())
    try:
        with engine.connect() as connection:
            # Connection parameters can override the database in the URL path.
            if connection.scalar(text("SELECT current_database()")) != parsed.database:
                pytest.fail(
                    "The PostgreSQL server connected to a different database than specified."
                )
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("DATABASE_URL", url)
            config = Config(Path(__file__).resolve().parents[1] / "alembic.ini")
            command.upgrade(config, "head")
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def db(migrated_db: Engine) -> Engine:
    with migrated_db.begin() as connection:
        connection.execute(text("TRUNCATE creation_ledger, polygons RESTART IDENTITY"))
    return migrated_db


@pytest.fixture
def api(db: Engine) -> Iterator[AsyncClient]:
    application = create_app(Settings(db.url.render_as_string(hide_password=False), 0))
    client = AsyncClient(
        transport=ASGITransport(app=application, raise_app_exceptions=False),
        base_url="http://localhost",
    )
    yield client
    asyncio.run(client.aclose())


def counts(db: Engine) -> tuple[int, int]:
    with db.connect() as connection:
        return (
            connection.execute(text("SELECT count(*) FROM polygons")).scalar_one(),
            connection.execute(text("SELECT count(*) FROM creation_ledger")).scalar_one(),
        )


def test_alembic_installs_polygon_and_ledger_tables(migrated_db: Engine) -> None:
    assert {"polygons", "creation_ledger"} <= set(inspect(migrated_db).get_table_names())


def test_e2e_database_guard_rejects_an_effective_database_override(migrated_db: Engine) -> None:
    url = migrated_db.url
    assert url.database is not None
    misleading_url = url.set(database="disposable_browser_test").update_query_dict(
        {"dbname": url.database}
    )
    with pytest.raises(ValueError, match="different database"):
        verify_e2e_database(misleading_url.render_as_string(hide_password=False))


def test_crud_round_trips_unicode_and_original_coordinates(api: AsyncClient, db: Engine) -> None:
    assert asyncio.run(api.get(POLYGONS)).json() == []
    assert asyncio.run(api.get("/healthz")).json() == {"status": "ok"}
    created = asyncio.run(api.post(POLYGONS, json=BODY))
    assert created.status_code == 201
    assert created.json() == {
        "id": 1,
        "name": "Lane 🚗",
        "points": [[0, 0], [1920, 0], [0.125, 1080]],
    }
    second = asyncio.run(api.post(POLYGONS, json=BODY))
    assert second.status_code == 201 and second.json()["id"] == 2
    assert asyncio.run(api.get(POLYGONS)).json() == [created.json(), second.json()]
    deleted = asyncio.run(api.delete(f"{POLYGONS}/1"))
    assert (deleted.status_code, deleted.content) == (204, b"")
    missing = asyncio.run(api.delete(f"{POLYGONS}/1"))
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "polygon_not_found"
    assert asyncio.run(api.get(POLYGONS)).json() == [second.json()]
    assert counts(db) == (1, 0)


def test_invalid_contour_creates_no_polygon_or_ledger(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}
    invalid = {"name": "Lane", "points": [[0, 0], [1, 1], [0.00001, 0]]}
    assert asyncio.run(api.post(POLYGONS, json=invalid, headers=headers)).status_code == 422
    assert counts(db) == (0, 0)
    assert asyncio.run(api.post(POLYGONS, json=BODY, headers=headers)).status_code == 201


def test_replay_normalizes_name_numbers_and_negative_zero(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}
    created = asyncio.run(api.post(POLYGONS, json=BODY, headers=headers))
    assert created.status_code == 201
    equivalent = {"name": "Lane 🚗", "points": [[-0.0, 0.0], [1920.0, -0.0], [0.125, 1080.0]]}
    replay = asyncio.run(api.post(POLYGONS, json=equivalent, headers=headers))
    assert (replay.status_code, replay.json()) == (200, created.json())
    rotated = {"name": "Lane 🚗", "points": [[1920, 0], [0.125, 1080], [0, 0]]}
    conflict = asyncio.run(api.post(POLYGONS, json=rotated, headers=headers))
    assert (
        conflict.status_code == 409 and conflict.json()["error"]["code"] == "idempotency_conflict"
    )
    assert counts(db) == (1, 1)


def test_concurrent_identical_posts_create_once(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}

    async def race() -> None:
        first, second = await asyncio.gather(
            api.post(POLYGONS, json=BODY, headers=headers),
            api.post(POLYGONS, json=BODY, headers=headers),
        )
        assert sorted([first.status_code, second.status_code]) == [200, 201]
        assert first.json() == second.json()

    asyncio.run(race())
    assert counts(db) == (1, 1)


def test_concurrent_different_bodies_for_one_key_conflict(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}

    async def race() -> None:
        first, second = await asyncio.gather(
            api.post(POLYGONS, json=BODY, headers=headers),
            api.post(POLYGONS, json={**BODY, "name": "Other"}, headers=headers),
        )
        assert sorted([first.status_code, second.status_code]) == [201, 409]
        conflict = first if first.status_code == 409 else second
        assert conflict.json()["error"]["code"] == "idempotency_conflict"

    asyncio.run(race())
    assert counts(db) == (1, 1)


def test_link_failure_rolls_back_key_claim_and_polygon(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}
    # Fail after the polygon insert, when the same transaction tries to link the key.
    with db.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE creation_ledger ADD CONSTRAINT test_link_failure CHECK (polygon_id IS NULL)"
            )
        )
    try:
        failed = asyncio.run(api.post(POLYGONS, json=BODY, headers=headers))
        assert failed.status_code == 500
        assert failed.json()["error"]["code"] == "internal_error"
        assert "test_link_failure" not in failed.text
        assert counts(db) == (0, 0)
    finally:
        with db.begin() as connection:
            connection.execute(
                text("ALTER TABLE creation_ledger DROP CONSTRAINT test_link_failure")
            )
    assert asyncio.run(api.post(POLYGONS, json=BODY, headers=headers)).status_code == 201
    assert counts(db) == (1, 1)


def test_replay_and_concurrent_deletes_leave_a_tombstone(api: AsyncClient, db: Engine) -> None:
    headers = {"Idempotency-Key": str(uuid4())}
    created = asyncio.run(api.post(POLYGONS, json=BODY, headers=headers))
    assert created.status_code == 201
    delete_url = f"{POLYGONS}/{created.json()['id']}"

    async def race() -> None:
        replay, first, second = await asyncio.gather(
            api.post(POLYGONS, json=BODY, headers=headers),
            api.delete(delete_url),
            api.delete(delete_url),
        )
        assert sorted([first.status_code, second.status_code]) == [204, 404]
        missing = first if first.status_code == 404 else second
        assert missing.json()["error"]["code"] == "polygon_not_found"
        assert replay.status_code in (200, 410)
        if replay.status_code == 200:
            assert replay.json() == created.json()
        else:
            assert replay.json()["error"]["code"] == "idempotency_result_deleted"

    asyncio.run(race())
    deleted = asyncio.run(api.post(POLYGONS, json=BODY, headers=headers))
    assert (
        deleted.status_code == 410
        and deleted.json()["error"]["code"] == "idempotency_result_deleted"
    )
    changed = asyncio.run(api.post(POLYGONS, json={**BODY, "name": "Other"}, headers=headers))
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "idempotency_conflict"
    assert asyncio.run(api.get(POLYGONS)).json() == []
    assert counts(db) == (0, 1)


def test_health_reports_database_unavailability(db: Engine) -> None:
    url = db.url.set(database=f"missing_{uuid4().hex}").render_as_string(hide_password=False)
    application = create_app(Settings(url, 0))

    async def read_health() -> None:
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.get("/healthz")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "database_unavailable"

    asyncio.run(read_health())


def test_replay_and_missing_delete_wait_before_database_access(
    api: AsyncClient, db: Engine
) -> None:
    headers = {"Idempotency-Key": str(uuid4())}
    created = asyncio.run(api.post(POLYGONS, json=BODY, headers=headers))
    assert created.status_code == 201

    async def check_delay() -> None:
        waiting: asyncio.Queue[float] = asyncio.Queue()
        release = asyncio.Event()

        async def sleep(seconds: float) -> None:
            waiting.put_nowait(seconds)
            await release.wait()

        settings = Settings(db.url.render_as_string(hide_password=False), 5)
        application = create_app(settings, sleep=sleep)
        async with (
            application.router.lifespan_context(application),
            AsyncClient(
                transport=ASGITransport(app=application), base_url="http://localhost"
            ) as client,
        ):
            with db.begin() as connection:
                # Both mutations would block if they entered PostgreSQL before sleeping.
                connection.execute(
                    text("LOCK TABLE polygons, creation_ledger IN ACCESS EXCLUSIVE MODE")
                )
                replay = asyncio.create_task(client.post(POLYGONS, json=BODY, headers=headers))
                missing = asyncio.create_task(client.delete(f"{POLYGONS}/2"))
                try:
                    assert await asyncio.wait_for(waiting.get(), 2) == 5
                    assert await asyncio.wait_for(waiting.get(), 2) == 5
                    assert not replay.done() and not missing.done()
                    assert (await asyncio.wait_for(client.get("/healthz"), 2)).status_code == 200
                finally:
                    release.set()
            responses = await asyncio.gather(replay, missing)
            assert responses[0].status_code == 200
            assert responses[1].status_code == 404

    asyncio.run(check_delay())


@contextmanager
def native_api(db: Engine, log_path: Path, *, use_default_delay: bool) -> Generator[Client]:
    env = {**os.environ, "DATABASE_URL": db.url.render_as_string(hide_password=False)}
    if use_default_delay:
        env.pop("CRUD_DELAY_SECONDS", None)
    else:
        env["CRUD_DELAY_SECONDS"] = "0"

    with socket.socket() as listener, log_path.open("w") as log:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        fd = listener.fileno()
        with subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--fd", str(fd)],
            cwd=Path(__file__).resolve().parents[1],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            pass_fds=(fd,),
        ) as process:
            listener.close()
            try:
                with Client(
                    base_url=f"http://127.0.0.1:{port}", timeout=12, trust_env=False
                ) as client:
                    deadline = monotonic() + 8
                    while monotonic() < deadline and process.poll() is None:
                        try:
                            if client.get("/healthz", timeout=0.5).status_code == 200:
                                break
                        except ConnectError, TimeoutException:
                            pass
                        sleep(0.05)
                    else:
                        pytest.fail(f"Native API did not start.\n{log_path.read_text()}")
                    yield client
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def test_native_default_delay_and_persistence_across_restart(db: Engine, tmp_path: Path) -> None:
    live_headers = {"Idempotency-Key": str(uuid4())}
    removed_headers = {"Idempotency-Key": str(uuid4())}
    with native_api(db, tmp_path / "first-api.log", use_default_delay=True) as first:

        async def timed_crud() -> tuple[Response, Response]:
            async with AsyncClient(base_url=first.base_url, timeout=12, trust_env=False) as client:

                async def timed(method: str, headers: dict[str, str] | None = None) -> Response:
                    start = monotonic()
                    response = await client.request(
                        method, POLYGONS, headers=headers, json=BODY if method == "POST" else None
                    )
                    assert monotonic() - start >= 4.9, f"{method} returned before five seconds"
                    return response

                live_task = asyncio.create_task(timed("POST", live_headers))
                removed_task = asyncio.create_task(timed("POST", removed_headers))
                list_task = asyncio.create_task(timed("GET"))
                await asyncio.sleep(0.15)
                health = await asyncio.wait_for(client.get("/healthz"), 3)
                assert health.status_code == 200
                assert not live_task.done() and not removed_task.done() and not list_task.done()
                live, removed, listed = await asyncio.gather(live_task, removed_task, list_task)
                assert (live.status_code, removed.status_code, listed.status_code) == (
                    201,
                    201,
                    200,
                )
                return live, removed

        live, removed = asyncio.run(timed_crud())
        start = monotonic()
        deleted = first.delete(f"{POLYGONS}/{removed.json()['id']}")
        assert monotonic() - start >= 4.9, "DELETE returned before five seconds"
        assert deleted.status_code == 204

    with native_api(db, tmp_path / "second-api.log", use_default_delay=False) as restarted:
        assert restarted.get(POLYGONS).json() == [live.json()]
        replay = restarted.post(POLYGONS, json=BODY, headers=live_headers)
        assert (replay.status_code, replay.json()) == (200, live.json())
        tombstone = restarted.post(POLYGONS, json=BODY, headers=removed_headers)
        assert tombstone.status_code == 410
        assert tombstone.json()["error"]["code"] == "idempotency_result_deleted"
        assert counts(db) == (1, 2)
