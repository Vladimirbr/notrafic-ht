import asyncio

from httpx import ASGITransport, AsyncClient

from app.main import app, create_app
from app.settings import DEFAULT_DATABASE_URL, Settings


def test_api_registers_crud_with_postgres_integer_ids() -> None:
    async def read_paths() -> object:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            return (await client.get("/openapi.json")).json()["paths"]

    paths = asyncio.run(read_paths())
    assert isinstance(paths, dict)
    assert "/api/polygons" in paths
    assert "/api/polygons/{polygon_id}" in paths


def test_native_api_rejects_an_unrecognized_host_before_dispatch() -> None:
    async def unexpected_delay(_: float) -> None:
        raise AssertionError("An unrecognized host reached the polygon handler")

    async def request() -> None:
        application = create_app(Settings(DEFAULT_DATABASE_URL, 0), sleep=unexpected_delay)
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://127.0.0.1"
        ) as client:
            response = await client.get("/api/polygons", headers={"Host": "unrelated.example"})
            assert response.status_code == 400

    asyncio.run(request())
