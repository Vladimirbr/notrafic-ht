import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import UUID4
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse

from app.contracts import ApiError, PolygonCreate, PolygonId, PolygonResponse
from app.polygons import create_polygon, delete_polygon, list_polygons
from app.settings import Settings

POLYGONS = "/api/polygons"


def _error_response(error: ApiError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": error.code, "message": error.message}}, status_code=error.status
    )


def _invalid_request() -> JSONResponse:
    return _error_response(ApiError(422, "validation_error", "The request has invalid data."))


def create_app(
    settings: Settings, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
) -> FastAPI:
    engine = create_engine(
        settings.sqlalchemy_url(),
        isolation_level="READ COMMITTED",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 2},
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        try:
            yield
        finally:
            await run_in_threadpool(engine.dispose)

    application = FastAPI(lifespan=lifespan)
    application.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"], www_redirect=False
    )

    @application.exception_handler(ApiError)
    async def api_error(_: Request, error: ApiError) -> JSONResponse:
        return _error_response(error)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, __: RequestValidationError) -> JSONResponse:
        return _invalid_request()

    @application.exception_handler(Exception)
    async def server_error(_: Request, __: Exception) -> JSONResponse:
        return _error_response(
            ApiError(500, "internal_error", "The server could not complete the request.")
        )

    @application.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> JSONResponse:
        # FastAPI reports non-JSON decoding errors (including invalid UTF-8) as HTTP 400.
        if error.status_code == 400:
            return _invalid_request()
        return JSONResponse(
            {
                "error": {
                    "code": "http_error",
                    "message": "The HTTP request could not be completed.",
                }
            },
            status_code=error.status_code,
            headers=error.headers,
        )

    @application.get("/healthz")
    def health() -> dict[str, str]:
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
        except OperationalError as error:
            raise ApiError(503, "database_unavailable", "The database is unavailable.") from error
        return {"status": "ok"}

    @application.get(POLYGONS)
    async def list_route() -> list[PolygonResponse]:
        await sleep(settings.crud_delay_seconds)
        return await run_in_threadpool(list_polygons, engine)

    @application.post(POLYGONS, status_code=201)
    async def create_route(
        body: PolygonCreate,
        response: Response,
        key: Annotated[UUID4 | None, Header(alias="Idempotency-Key")] = None,
    ) -> PolygonResponse:
        await sleep(settings.crud_delay_seconds)
        polygon, created = await run_in_threadpool(create_polygon, engine, body, key)
        response.status_code = 201 if created else 200
        return polygon

    @application.delete(f"{POLYGONS}/{{polygon_id}}", status_code=204)
    async def delete_route(polygon_id: PolygonId) -> Response:
        await sleep(settings.crud_delay_seconds)
        await run_in_threadpool(delete_polygon, engine, polygon_id)
        return Response(status_code=204)

    return application


app = create_app(Settings.from_environment())
