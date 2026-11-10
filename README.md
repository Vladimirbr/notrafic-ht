# NoTraffic Polygon Editor

Draw named polygons over a scene, then save or delete them. The API stores polygons in PostgreSQL and waits five seconds before each dispatched create, list, or delete operation. The editor supports mouse and touch and keeps vertices aligned with the image when the viewport changes.

## Local development

Use macOS or Linux, including WSL2, with Docker Engine 28 or later, Compose v2, Node.js 26.13.0, pnpm 12.18.0, and uv 0.13.7. uv installs the pinned Python 3.15.2 runtime if needed.

```sh
pnpm install --frozen-lockfile
uv sync --locked --directory backend
pnpm dev
```

Open [the editor](http://localhost:5173). The command starts PostgreSQL in Docker, applies the Alembic migration, and starts Vite and Uvicorn on the host. Vite forwards API requests to Uvicorn on port 8000. PostgreSQL is available on loopback port 55432. Ctrl+C stops Vite and Uvicorn. Use `docker compose stop postgres` to stop the database while retaining its data.

Set `FRONTEND_PORT`, `API_PORT`, or `POSTGRES_PORT` if a default port is occupied. To use an existing PostgreSQL instance, pass `DATABASE_URL` to `pnpm dev`. It skips starting the Compose database and applies migrations to the supplied database.

## Docker Compose

Stop the native app before starting Compose on the same frontend port.

```sh
docker compose up -d --build --wait
docker compose ps
```

Open [the editor](http://localhost:5173). Nginx serves the built frontend and forwards API requests on the same origin. Check [API and database readiness](http://localhost:5173/healthz). PostgreSQL uses the named `postgres-data` volume. Run `docker compose down` to stop the stack while keeping the volume. Set `FRONTEND_PORT` or `POSTGRES_PORT` to change the published ports.

## Manual check

1. Click or tap empty space to place the first vertex, or choose **New polygon** to start an empty draft. Close a valid shape with a mouse double-click, the first vertex, **Finish shape**, or **Enter** on the canvas. Drag a vertex to adjust the draft.
2. Name the shape and choose **Save polygon** or press **Enter**. Draw another shape while the first saves. Open **Save queue** to see each pending shape's status. Confirmed shapes turn teal and appear in **Saved polygons**.
3. Select the polygon on the scene or in the list and choose **Delete**. After the API responds, the polygon disappears. On touch devices, swipe outside the vertex handles to scroll without adding a point.

Use **Undo point**, **Back to drawing**, or **Cancel** while editing. With the canvas or the selected row focused, **Delete** or **Backspace** deletes the selected saved polygon.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm --filter @notraffic/frontend exec playwright install chromium firefox webkit
pnpm check
pnpm test:compose
```

On Linux, add `--with-deps` to the Playwright install command if the browser system libraries are missing.

`pnpm check` uses a frozen installation. It runs Ruff, Pyright, ESLint, Prettier, backend tests with coverage, browser and unit tests with coverage, the TypeScript/Vite build, native Playwright E2E, and dependency audits. Both apps enforce a minimum of 90% for lines and for branches. Playwright tests use an intercepted photo at the specified Picsum URL. Run `pnpm test:e2e --live-image` to exercise the real image service separately.

Tests use disposable PostgreSQL databases. Set `TEST_POSTGRES_PORT` if the default test port (55433) is occupied. `pnpm test:compose` checks API recovery and PostgreSQL persistence in a separate stack.

## API

Use `GET /api/polygons` to list polygons, `POST /api/polygons` to create one, and `DELETE /api/polygons/{id}` to delete it. A create request looks like `{"name":"Lane A","points":[[480,270],[1440,270],[960,810]]}`. Points use the original 1920 × 1080 scene coordinates.

## Design decisions and trade-offs

### Shared collection

Clients using the same database share one polygon collection. The demo binds to loopback and assumes trusted local clients. Each browser profile caches its own scene from `https://picsum.photos/1920/1080`, so a new profile can show a different image behind the same saved shapes.

### List pagination and startup cache

The canvas needs the full collection, so the editor fetches it in one request and pages only the sidebar. Page changes are immediate. Refreshes still transfer the full collection. On repeat visits the editor shows the browser's cached list while waiting for the API.

### Save queue and recovery

The browser keeps one editable draft and a durable save queue. The queue sends one request at a time, shared across tabs on the same origin, and resumes when the editor is open. The canvas uses different outline colors for queued, saving, retrying, paused, failed, saved, and deleting shapes. The queue also shows text labels.

If an API response is lost, the browser retries the same request without creating a duplicate. If the queue pauses, use **Retry queue**. Failed shapes that can be corrected offer **Restore as draft** when the original image is available and the draft slot is free.

## Repository layout

| Path        | Contents                                                         |
| ----------- | ---------------------------------------------------------------- |
| `frontend/` | React and Konva editor, browser tests, and Playwright scenarios  |
| `backend/`  | FastAPI API, Alembic migrations, and Python tests                |
| `fixtures/` | Shared name and geometry test cases for TypeScript and Python    |
| `scripts/`  | Entry points for local development, quality checks, and E2E runs |
