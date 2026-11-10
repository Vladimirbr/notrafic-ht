import { normalizeName, validContour, type Point } from "./geometry";

export type PolygonBody = {
  readonly name: string;
  readonly points: readonly Point[];
};

export type Polygon = PolygonBody & { readonly id: number };

export type Submission = {
  readonly key: string;
  readonly body: PolygonBody;
};

export type SaveResult =
  | { kind: "saved"; polygon: Polygon }
  | { kind: "invalid" | "deleted" | "conflict" | "unknown" };

type Transport = typeof fetch;

const POLYGONS_PATH = "/api/polygons";
const REQUEST_DEADLINE = 15_000;
const MAX_POLYGON_ID = 2_147_483_647;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function parsePolygon(value: unknown): Polygon | null {
  const fields = record(value);
  if (!fields) return null;
  const { id, name, points } = fields;
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id <= 0 ||
    id > MAX_POLYGON_ID ||
    typeof name !== "string" ||
    normalizeName(name) !== name ||
    !Array.isArray(points) ||
    !points.every(isPoint) ||
    !validContour(points)
  ) {
    return null;
  }
  return { id, name, points };
}

export function parsePolygonList(value: unknown): readonly Polygon[] | null {
  if (!Array.isArray(value)) return null;
  const polygons: Polygon[] = [];
  let lastId = 0;
  for (const item of value as unknown[]) {
    const polygon = parsePolygon(item);
    if (!polygon || polygon.id <= lastId) return null;
    polygons.push(polygon);
    lastId = polygon.id;
  }
  return polygons;
}

export function mergePolygons(
  previous: readonly Polygon[],
  confirmed: readonly Polygon[],
): readonly Polygon[] {
  const byId = new Map(previous.map((polygon) => [polygon.id, polygon]));
  for (const polygon of confirmed) byId.set(polygon.id, polygon);
  return [...byId.values()].sort((first, second) => first.id - second.id);
}

function errorCode(value: unknown): unknown {
  const error = record(record(value)?.error);
  return error && typeof error.message === "string" ? error.code : null;
}

function matchesBody(polygon: Polygon, body: PolygonBody): boolean {
  return (
    polygon.name === body.name &&
    polygon.points.length === body.points.length &&
    polygon.points.every(([x, y], index) => {
      const point = body.points[index];
      return point?.[0] === x && point[1] === y;
    })
  );
}

export class PolygonApi {
  constructor(
    private readonly transport: Transport = (input, init) => fetch(input, init),
  ) {}

  async list(): Promise<readonly Polygon[] | null> {
    return this.request(POLYGONS_PATH, { method: "GET" }, async (response) => {
      if (response.status !== 200) return null;
      return parsePolygonList(await response.json());
    });
  }

  async save(submission: Submission): Promise<SaveResult> {
    const result = await this.request<SaveResult>(
      POLYGONS_PATH,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key,
        },
        body: JSON.stringify(submission.body),
      },
      async (response) => {
        const value: unknown = await response.json();
        if (response.status === 200 || response.status === 201) {
          const polygon = parsePolygon(value);
          return polygon && matchesBody(polygon, submission.body)
            ? { kind: "saved", polygon }
            : null;
        }
        const code = errorCode(value);
        if (response.status === 422 && code === "validation_error")
          return { kind: "invalid" };
        if (response.status === 410 && code === "idempotency_result_deleted") {
          return { kind: "deleted" };
        }
        if (response.status === 409 && code === "idempotency_conflict")
          return { kind: "conflict" };
        return null;
      },
    );
    return result ?? { kind: "unknown" };
  }

  async delete(id: number): Promise<boolean> {
    return (
      (await this.request(
        `${POLYGONS_PATH}/${String(id)}`,
        { method: "DELETE" },
        async (response) => {
          if (response.status === 204) return true;
          if (response.status !== 404) return false;
          const value: unknown = await response.json();
          return errorCode(value) === "polygon_not_found";
        },
      )) === true
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<T | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, REQUEST_DEADLINE);
    });
    try {
      const result = this.transport(path, {
        ...init,
        signal: controller.signal,
      }).then(parse);
      return await Promise.race([result, deadline]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
