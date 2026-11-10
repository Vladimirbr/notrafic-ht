import asyncio
import json
from collections.abc import Iterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.settings import DEFAULT_DATABASE_URL, Settings

VALID_BODY = {"name": "Lane A", "points": [[0, 0], [100, 0], [0, 100]]}


@pytest.fixture
def api() -> Iterator[AsyncClient]:
    application = create_app(Settings(DEFAULT_DATABASE_URL, 0))
    client = AsyncClient(transport=ASGITransport(app=application), base_url="http://localhost")
    yield client
    asyncio.run(client.aclose())


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"{",
        b"null",
        b"[]",
        b"{}",
        b'{"name":"\xff","points":[[0,0],[1,0],[0,1]]}',
        rb'{"name":"\uD800","points":[[0,0],[1,0],[0,1]]}',
        rb'{"name":"A\u0000","points":[[0,0],[1,0],[0,1]]}',
        b'{"name":"A","points":[[NaN,0],[1,0],[0,1]]}',
        b'{"name":"A","points":[[Infinity,0],[1,0],[0,1]]}',
        b'{"name":"A","points":[[1e309,0],[1,0],[0,1]]}',
        json.dumps({"name": "A", "points": [[10**400, 0], [1, 0], [0, 1]]}).encode(),
        json.dumps({"name": True, "points": VALID_BODY["points"]}).encode(),
        json.dumps({"name": " ", "points": VALID_BODY["points"]}).encode(),
        json.dumps({"name": "🚗" * 101, "points": VALID_BODY["points"]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1, 0, 2], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [True, 0], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], ["1", 0], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[-0.1, 0], [1, 0], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1920.1, 0], [0, 1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1, 0], [0, 1080.1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1, 0], [0, -0.1]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1, 0]]}).encode(),
        json.dumps({"name": "A", "points": [[0, 0]] * 1001}).encode(),
        json.dumps({"name": "A", "points": [[0, 0], [1, 0], [1, 1], [1, 0]]}).encode(),
    ],
)
def test_invalid_body_returns_a_safe_error(api: AsyncClient, body: bytes) -> None:
    response = asyncio.run(
        api.post("/api/polygons", content=body, headers={"Content-Type": "application/json"})
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert isinstance(error["message"], str) and error["message"]
    assert set(error) == {"code", "message"}
    assert "input" not in response.json()


def test_nonfinite_value_in_an_extra_field_is_rejected_before_dispatch() -> None:
    async def fail_on_dispatch(_: float) -> None:
        pytest.fail("The malformed body reached the CRUD delay.")

    async def request() -> None:
        application = create_app(Settings(DEFAULT_DATABASE_URL, 0), sleep=fail_on_dispatch)
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/polygons",
                content=b'{"name":"A","points":[[0,0],[1,0],[0,1]],"extra":NaN}',
                headers={"Content-Type": "application/json"},
            )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"
        assert "NaN" not in response.text

    asyncio.run(request())


@pytest.mark.parametrize("polygon_id", ["0", "-1", "1.0", "wrong", "2147483648", "9" * 5000])
def test_delete_rejects_ids_outside_the_positive_postgres_integer_range(
    api: AsyncClient, polygon_id: str
) -> None:
    response = asyncio.run(api.delete(f"/api/polygons/{polygon_id}"))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("key", ["", "bad", "f47ac10b-58cc-11cf-a447-001122334455"])
def test_create_rejects_non_v4_keys(api: AsyncClient, key: str) -> None:
    response = asyncio.run(
        api.post("/api/polygons", json=VALID_BODY, headers={"Idempotency-Key": key})
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_unsupported_method_keeps_a_safe_error_and_the_allow_header(api: AsyncClient) -> None:
    response = asyncio.run(api.patch("/api/polygons"))
    assert response.status_code == 405
    assert response.headers["allow"] in {"GET", "POST"}
    assert response.json()["error"]["code"] == "http_error"
