import { describe, expect, it, vi } from "vitest";

import { PolygonApi } from "./api";

const submission = {
  key: "3f7a5933-c664-4057-92ad-8f19e5bc4f73",
  body: {
    name: "Lane A",
    points: [
      [12.5, 30],
      [100, 30],
      [100, 200],
    ] as const,
  },
};
const polygon = { id: 1, ...submission.body };

function apiReturning(response: Response) {
  return new PolygonApi(() => Promise.resolve(response));
}

describe("polygon HTTP contract", () => {
  it("reads a plain ordered collection including an empty collection", async () => {
    expect(
      await apiReturning(
        Response.json([polygon, { ...polygon, id: 2 }]),
      ).list(),
    ).toEqual([polygon, { ...polygon, id: 2 }]);
    expect(await apiReturning(Response.json([])).list()).toEqual([]);
  });

  it.each(
    [
      { polygons: [polygon] },
      [null],
      [{ ...polygon, id: 0 }],
      [{ ...polygon, id: "1" }],
      [{ ...polygon, id: 2147483648 }],
      [{ ...polygon, id: 1.5 }],
      [{ ...polygon, name: null }],
      [{ ...polygon, name: " Lane A" }],
      [{ ...polygon, points: {} }],
      [{ ...polygon, points: [false] }],
      [{ ...polygon, points: [[1, 2, 3]] }],
      [{ ...polygon, points: [["1", 2]] }],
      [{ ...polygon, points: [[1, "2"]] }],
      [
        {
          ...polygon,
          points: [
            [1, 2],
            [3, 4],
            [5, 6],
          ],
        },
      ],
      [polygon, { ...polygon }],
      [{ ...polygon, id: 2 }, polygon],
    ].map((invalid) => ({ invalid })),
  )("rejects an invalid collection $invalid", async ({ invalid }) => {
    expect(await apiReturning(Response.json(invalid)).list()).toBeNull();
  });

  it("rejects unsuccessful statuses and invalid JSON", async () => {
    expect(
      await apiReturning(Response.json([], { status: 201 })).list(),
    ).toBeNull();
    expect(await apiReturning(new Response("broken JSON")).list()).toBeNull();
  });

  it.each([200, 201])(
    "returns a created row on %i and sends the original frozen payload",
    async (status) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(polygon, { status }));
      expect(await new PolygonApi(transport).save(submission)).toEqual({
        kind: "saved",
        polygon,
      });
      expect(transport.mock.calls[0]?.[0]).toBe("/api/polygons");
      expect(transport.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key,
        },
        body: '{"name":"Lane A","points":[[12.5,30],[100,30],[100,200]]}',
      });
    },
  );

  it.each([
    [422, "validation_error", "invalid"],
    [410, "idempotency_result_deleted", "deleted"],
    [409, "idempotency_conflict", "conflict"],
    [422, "proxy_error", "unknown"],
    [410, "proxy_error", "unknown"],
    [409, "proxy_error", "unknown"],
    [500, "validation_error", "unknown"],
  ])("classifies status %i and code %s as %s", async (status, code, kind) => {
    const response = Response.json(
      { error: { code, message: "Safe explanation" } },
      { status },
    );
    expect(await apiReturning(response).save(submission)).toEqual({ kind });
  });

  it.each([
    [201, {}],
    [201, { ...polygon, name: "Different name" }],
    [
      200,
      {
        ...polygon,
        points: [
          [13, 30],
          [100, 30],
          [100, 200],
        ],
      },
    ],
    [409, null],
    [410, { error: null }],
    [422, { error: { code: "validation_error" } }],
  ])(
    "preserves uncertainty when status %i has malformed body %j",
    async (status, body) => {
      expect(
        await apiReturning(Response.json(body, { status })).save(submission),
      ).toEqual({
        kind: "unknown",
      });
    },
  );

  it("only confirms a successful or typed absent delete", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "unavailable", message: "Proxy" } },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "polygon_not_found", message: "Absent" } },
          { status: 404 },
        ),
      )
      .mockRejectedValueOnce(new TypeError("Network failure"));
    const api = new PolygonApi(transport);

    for (const expected of [true, false, false, true, false]) {
      expect(await api.delete(7)).toBe(expected);
    }
    expect(transport).toHaveBeenCalledTimes(5);
    expect(transport.mock.calls[0]?.[0]).toBe("/api/polygons/7");
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("aborts and resolves uncertainty at 15 seconds even if the transport stays pending", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const pending = new PolygonApi(async (_path, options) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      }).save(submission);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ kind: "unknown" });
    } finally {
      vi.useRealTimers();
    }
  });
});
