import { afterEach, describe, expect, it, vi } from "vitest";

import { PolygonApi } from "./api";
import { Editor } from "./editor";
import { BrowserWorkspaceStore, randomId, type Workspace } from "./workspace";

const points = [
  [10, 10],
  [100, 10],
  [100, 100],
] as const;
const body = { name: "Lane A", points };
const polygon = { id: 7, ...body };
const imageUrl = "https://picsum.photos/1920/1080";

function picture(width = 1920, height = 1080) {
  return new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}"><rect width="100%" height="100%" fill="navy"/></svg>`,
    ],
    { type: "image/svg+xml" },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(
  transport: typeof fetch = () => Promise.resolve(Response.json([])),
) {
  const database = randomId();
  const storage = new BrowserWorkspaceStore(database);
  const fetchImage = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(picture())),
  );
  const make = () =>
    new Editor({ storage, api: new PolygonApi(transport), fetchImage });
  return { make, editor: make(), storage, database, fetchImage };
}

function draft(editor: Editor, name = " \u0085Lane A\uFEFF ") {
  editor.newPolygon();
  for (const point of points) editor.addPoint(point);
  editor.finish();
  editor.setName(name);
}

async function setCachedImage(
  database: string,
  imageId: string,
  value?: unknown,
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(database);
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      reject(open.error ?? new Error("Open failed"));
    };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      const images = tx.objectStore("images");
      if (value === undefined) images.delete(imageId);
      else images.put(value, imageId);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("Cache change aborted"));
      };
    });
  } finally {
    db.close();
  }
}

function imageId(workspace: Workspace) {
  if (workspace.imageId === null) throw new Error("Expected stored image");
  return workspace.imageId;
}

afterEach(() => vi.restoreAllMocks());

describe("workspace editing and image recovery", () => {
  it("loads image and collection independently, reuses the picture and restores naming and drawing", async () => {
    const pending = deferred<Response>();
    const { editor, make, storage, fetchImage } = setup(() =>
      pending.promise.then((response) => response.clone()),
    );
    const started = editor.start();
    void editor.start();
    await expect.poll(() => editor.getSnapshot().imageStatus).toBe("ready");
    expect(editor.getSnapshot().listStatus).toBe("loading");
    expect(fetchImage.mock.calls[0]?.[0]).toBe(imageUrl);
    expect(fetchImage.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const snapshot = editor.getSnapshot();
    expect(editor.getSnapshot()).toBe(snapshot);
    let updates = 0;
    const stop = editor.subscribe(() => {
      updates++;
    });
    editor.newPolygon();
    editor.newPolygon();
    editor.finish();
    editor.undo();
    editor.setName("Ignored while drawing");
    expect(editor.getSnapshot().draft).toMatchObject({
      phase: "drawing",
      name: "",
      points: [],
    });
    editor.addPoint([-1, 3]);
    for (const point of points) editor.addPoint(point);
    editor.undo();
    editor.addPoint(points[2]);
    editor.finish();
    editor.setName("Lane A");
    editor.addPoint([500, 500]);
    editor.back();
    expect(editor.getSnapshot().draft).toMatchObject({
      phase: "drawing",
      name: "Lane A",
      points,
    });
    expect(updates).toBeGreaterThan(0);
    stop();
    const updateCount = updates;
    const currentId = imageId(await storage.read());
    await expect
      .poll(async () => (await storage.read()).draft)
      .toMatchObject({ phase: "drawing", name: "Lane A", points });

    const restored = make();
    pending.resolve(Response.json([]));
    await Promise.all([started, restored.start()]);
    expect(updates).toBe(updateCount);
    expect(restored.getSnapshot().draft).toMatchObject({
      phase: "drawing",
      name: "Lane A",
      points,
    });
    restored.finish();
    await expect
      .poll(async () => (await storage.read()).draft?.phase)
      .toBe("naming");
    const naming = make();
    await naming.start();
    expect(naming.getSnapshot().draft).toMatchObject({
      phase: "naming",
      name: "Lane A",
      points,
    });
    await naming.cancel();
    expect(naming.getSnapshot().draft).toBeNull();
    expect(imageId(await storage.read())).toBe(currentId);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("retries an image request failure and rejects unexpected dimensions", async () => {
    const { editor, fetchImage, storage } = setup();
    fetchImage
      .mockRejectedValueOnce(new TypeError("Image transport unavailable"))
      .mockResolvedValueOnce(new Response(picture(500, 300)))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await editor.start();
    expect(editor.getSnapshot()).toMatchObject({
      imageStatus: "error",
      listStatus: "ready",
    });
    editor.newPolygon();
    expect(editor.getSnapshot().draft).toBeNull();
    await editor.retryImage();
    expect(editor.getSnapshot().imageStatus).toBe("error");
    await editor.retryImage();
    expect(editor.getSnapshot().imageStatus).toBe("error");
    await editor.retryImage();
    await editor.retryImage();
    expect(editor.getSnapshot().image).toMatchObject({
      naturalWidth: 1920,
      naturalHeight: 1080,
    });
    expect((await storage.read()).revision).toBe(1);
    expect(fetchImage).toHaveBeenCalledTimes(4);
  });

  it("leaves the loading state after an image timeout and retries", async () => {
    const { storage } = setup();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const requested = deferred<undefined>();
    const editor = new Editor({
      storage,
      api: new PolygonApi(() => Promise.resolve(Response.json([]))),
      fetchImage: (_url, init) => {
        requested.resolve(undefined);
        if (init?.signal !== controller.signal)
          return Promise.resolve(new Response(picture()));
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Timed out", "TimeoutError"));
            },
            { once: true },
          );
        });
      },
    });
    const starting = editor.start();
    await requested.promise;
    controller.abort();
    await starting;
    expect(editor.getSnapshot().imageStatus).toBe("error");
    await editor.retryImage();
    expect(editor.getSnapshot().imageStatus).toBe("ready");
  });

  it.each([
    undefined,
    "invalid entry",
    { bytes: new ArrayBuffer(1), type: 1 },
    new Blob(["corrupt"]),
  ])(
    "repairs an absent or corrupt image without a draft (%s)",
    async (badImage) => {
      const { editor, make, storage, database, fetchImage } = setup();
      await editor.start();
      const previous = imageId(await storage.read());
      await setCachedImage(database, previous, badImage);
      const reopened = make();
      await reopened.start();
      expect(reopened.getSnapshot().imageStatus).toBe("error");
      expect(fetchImage).toHaveBeenCalledTimes(1);
      await reopened.retryImage();
      expect(reopened.getSnapshot().imageStatus).toBe("ready");
      expect(imageId(await storage.read())).not.toBe(previous);
    },
  );

  it("keeps an editable draft bound to its missing picture until explicit discard", async () => {
    const { editor, make, storage, database, fetchImage } = setup();
    await editor.start();
    draft(editor);
    await expect
      .poll(async () => (await storage.read()).draft?.name)
      .toBe(" \u0085Lane A\uFEFF ");
    const original = imageId(await storage.read());
    await setCachedImage(database, original, new Blob(["corrupt"]));
    const reopened = make();
    await reopened.start();
    await reopened.retryImage();
    reopened.back();
    await reopened.save();
    expect(reopened.getSnapshot()).toMatchObject({
      imageStatus: "missing",
      draft: { phase: "naming", points },
    });
    expect(fetchImage).toHaveBeenCalledTimes(1);
    await reopened.cancel();
    await reopened.retryImage();
    expect(imageId(await storage.read())).not.toBe(original);
    expect(reopened.getSnapshot().imageStatus).toBe("ready");
  });

  it("adopts the first image committed by concurrent initializers", async () => {
    const { editor, make, fetchImage, storage } = setup();
    const other = make();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchImage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const pending = Promise.all([editor.start(), other.start()]);
    await expect.poll(() => fetchImage.mock.calls.length).toBe(2);
    second.resolve(new Response(picture()));
    await expect.poll(async () => (await storage.read()).revision).toBe(1);
    first.resolve(new Response(picture()));
    await pending;
    expect(editor.getSnapshot()).toMatchObject({
      imageStatus: "ready",
      stale: false,
    });
    expect(other.getSnapshot()).toMatchObject({
      imageStatus: "ready",
      stale: false,
    });
    expect((await storage.read()).revision).toBe(1);
  });
});

describe("durable save and list operations", () => {
  it("stores an offline save and starts sending on reconnect", async () => {
    const connectivity = vi
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    let posts = 0;
    const { editor } = setup((_path, init) => {
      if (init?.method !== "POST") return Promise.resolve(Response.json([]));
      posts++;
      return Promise.resolve(Response.json(polygon));
    });
    try {
      await editor.start();
      draft(editor);
      await editor.save();
      expect(
        editor.getSnapshot().queue.map(({ state }) => state.status),
      ).toEqual(["queued"]);
      expect(posts).toBe(0);
      connectivity.mockReturnValue(true);
      window.dispatchEvent(new Event("online"));
      await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
      expect(posts).toBe(1);
    } finally {
      connectivity.mockRestore();
    }
  });

  it("durably enqueues three polygons with no confirmed list while one POST is held", async () => {
    const response = deferred<Response>();
    const requests: RequestInit[] = [];
    const { editor } = setup((_path, init) => {
      if (init?.method !== "POST")
        return Promise.resolve(new Response(null, { status: 503 }));
      requests.push(init);
      const id = requests.length;
      return id === 1
        ? response.promise
        : Promise.resolve(Response.json({ id, ...body }));
    });
    await editor.start();
    expect(editor.getSnapshot().listLoaded).toBe(false);
    draft(editor);
    await Promise.all([editor.save(), editor.save()]);
    expect(editor.getSnapshot().draft).toBeNull();
    await expect.poll(() => requests.length).toBe(1);
    draft(editor);
    await editor.save();
    draft(editor);
    await editor.save();
    expect(editor.getSnapshot().draft).toBeNull();
    expect(editor.getSnapshot().queue.map(({ state }) => state.status)).toEqual(
      ["sending", "queued", "queued"],
    );
    expect(requests).toHaveLength(1);
    response.resolve(Response.json({ id: 1, ...body }));
    await expect
      .poll(() => editor.getSnapshot().polygons.map(({ id }) => id))
      .toEqual([1, 2, 3]);
    expect(editor.getSnapshot().queue).toEqual([]);
    expect(requests.map(({ body: raw }) => raw)).toEqual(
      Array(3).fill(JSON.stringify(body)),
    );
    const keys = requests.map(({ headers }) =>
      new Headers(headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("gives a foreground refresh a turn before the next save attempt", async () => {
    const firstSave = deferred<Response>();
    const refresh = deferred<Response>();
    const requests: string[] = [];
    const { editor } = setup((_path, init) => {
      requests.push(init?.method ?? "GET");
      if (requests.length === 1)
        return Promise.resolve(Response.json([polygon]));
      if (requests.length === 2) return firstSave.promise;
      if (requests.length === 3) return refresh.promise;
      return Promise.resolve(Response.json({ ...polygon, id: 9 }));
    });
    await editor.start();
    draft(editor);
    await editor.save();
    await expect.poll(() => requests).toEqual(["GET", "POST"]);
    draft(editor);
    await editor.save();
    const refreshing = editor.refreshList();
    expect(editor.getSnapshot().operation).toBe("list");
    firstSave.resolve(Response.json({ ...polygon, id: 8 }));
    await expect.poll(() => requests).toEqual(["GET", "POST", "GET"]);
    refresh.resolve(new Response("Proxy", { status: 502 }));
    await refreshing;
    await expect.poll(() => editor.getSnapshot().queue).toEqual([]);
    expect(editor.getSnapshot()).toMatchObject({
      listLoaded: true,
      listStatus: "error",
      polygons: [polygon, { ...polygon, id: 8 }, { ...polygon, id: 9 }],
    });
    expect(requests).toEqual(["GET", "POST", "GET", "POST"]);
  });

  it("rechecks a visibly waiting delete when another tab removes its ID", async () => {
    const pending = deferred<Response>();
    const requests: string[] = [];
    const { editor, make } = setup((_path, init) => {
      requests.push(init?.method ?? "GET");
      if (requests.length === 3) return pending.promise;
      if (init?.method === "DELETE")
        return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json([polygon]));
    });
    const other = make();
    await editor.start();
    await other.start();
    draft(editor);
    await editor.save();
    await expect.poll(() => requests.length).toBe(3);
    const firstDelete = other.deletePolygon(polygon.id);
    const secondDelete = editor.deletePolygon(polygon.id);
    expect(editor.getSnapshot()).toMatchObject({
      operation: "delete",
      deletingId: polygon.id,
    });
    pending.resolve(Response.json({ ...polygon, id: 8 }));
    await Promise.all([firstDelete, secondDelete]);
    expect(requests).toEqual(["GET", "GET", "POST", "DELETE"]);
    expect(editor.getSnapshot()).toMatchObject({
      operation: null,
      deletingId: null,
      polygons: [{ ...polygon, id: 8 }],
    });
  });

  it("retains a pending delete and clears only after typed confirmation", async () => {
    const pending = deferred<Response>();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([polygon]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "polygon_not_found", message: "Absent" } },
          { status: 404 },
        ),
      );
    const { editor } = setup(transport);
    await editor.start();
    await editor.deletePolygon(20);
    const deleting = editor.deletePolygon(7);
    expect(editor.getSnapshot()).toMatchObject({
      operation: "delete",
      deletingId: 7,
      polygons: [polygon],
    });
    await editor.refreshList();
    await editor.deletePolygon(7);
    pending.resolve(new Response("Proxy not found", { status: 404 }));
    await deleting;
    expect(editor.getSnapshot()).toMatchObject({
      operation: null,
      deletingId: null,
      deleteError: true,
      polygons: [polygon],
    });
    await editor.deletePolygon(7);
    expect(editor.getSnapshot()).toMatchObject({
      deleteError: false,
      polygons: [],
    });
  });

  it("clears a lost delete response only after a successful refresh confirms the collection", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([polygon]))
      .mockRejectedValueOnce(new TypeError("Lost delete response"))
      .mockResolvedValueOnce(new Response("Proxy unavailable", { status: 502 }))
      .mockResolvedValueOnce(Response.json([]));
    const { editor } = setup(transport);
    await editor.start();
    await editor.deletePolygon(polygon.id);
    expect(editor.getSnapshot()).toMatchObject({
      deleteError: true,
      polygons: [polygon],
    });
    await editor.refreshList();
    expect(editor.getSnapshot()).toMatchObject({
      deleteError: true,
      listStatus: "error",
      polygons: [polygon],
    });
    await editor.refreshList();
    expect(editor.getSnapshot()).toMatchObject({
      deleteError: false,
      listStatus: "ready",
      polygons: [],
    });
  });

  it("recovers a durable unknown result with the exact key and body, even without the photo", async () => {
    const attempts: RequestInit[] = [];
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { editor, make, storage, database } = setup((_path, init) => {
      if (init?.method !== "POST")
        return Promise.resolve(new Response(null, { status: 502 }));
      attempts.push(init);
      if (attempts.length > 1) return Promise.resolve(Response.json(polygon));
      return Promise.reject(new TypeError("Lost committed response"));
    });
    await editor.start();
    draft(editor);
    await editor.save();
    await expect
      .poll(() => editor.getSnapshot().queue[0]?.state)
      .toEqual({
        status: "retrying",
        attempts: 1,
        retryAt: 12_000,
      });
    online.mockReturnValue(false);
    await setCachedImage(database, imageId(await storage.read()));
    const recovered = make();
    await recovered.start();
    expect(recovered.getSnapshot()).toMatchObject({
      listLoaded: false,
      listStatus: "error",
      imageStatus: "missing",
    });
    now.mockReturnValue(12_000);
    window.dispatchEvent(new Event("focus"));
    expect(attempts).toHaveLength(1);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await expect
      .poll(() => recovered.getSnapshot().polygons)
      .toEqual([polygon]);
    expect(recovered.getSnapshot().queue).toEqual([]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.headers).toEqual(attempts[0]?.headers);
    expect(attempts[1]?.body).toBe(JSON.stringify(body));
    expect(attempts[1]?.body).toBe(attempts[0]?.body);
    expect((await storage.readView()).receipts).toEqual([polygon]);
  });

  it("persists backoff and pauses the head after the last retry until manual retry", async () => {
    const attempts: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { editor, storage } = setup((_path, init) => {
      if (init?.method !== "POST") return Promise.resolve(Response.json([]));
      attempts.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (attempts.length <= 4) {
        return Promise.resolve(
          Response.json(
            { error: { code: "unexpected", message: "Proxy error" } },
            { status: 409 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({ ...polygon, id: attempts.length }),
      );
    });
    await editor.start();
    draft(editor);
    await editor.save();
    draft(editor);
    await editor.save();

    for (const [count, retryAt] of [
      [1, 3000],
      [2, 8000],
      [3, 23000],
    ] as const) {
      await expect
        .poll(async () => (await storage.readView()).queue[0]?.state)
        .toEqual({
          status: "retrying",
          attempts: count,
          retryAt,
        });
      expect(attempts).toHaveLength(count);
      now.mockReturnValue(retryAt);
      window.dispatchEvent(new Event("focus"));
    }
    await expect
      .poll(() => editor.getSnapshot().queue.map(({ state }) => state.status))
      .toEqual(["paused", "queued"]);
    expect(attempts).toHaveLength(4);
    await editor.retryQueue();
    await expect.poll(() => editor.getSnapshot().queue).toEqual([]);
    expect(attempts).toHaveLength(6);
    expect(new Set(attempts.slice(0, 5)).size).toBe(1);
    expect(attempts[5]).not.toBe(attempts[0]);
  });

  it.each([
    [422, "validation_error", "invalid"],
    [410, "idempotency_result_deleted", "deleted"],
  ])(
    "retains a definitive %i failure and restores it only to an empty editable slot",
    async (status, code, reason) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(
          Response.json({ error: { code, message: "Resolved" } }, { status }),
        )
        .mockResolvedValueOnce(Response.json(polygon, { status: 201 }));
      const { editor, storage } = setup(transport);
      await editor.start();
      draft(editor);
      await editor.save();
      await expect
        .poll(() => editor.getSnapshot().queue[0]?.state)
        .toEqual({ status: "failed", reason });
      const item = editor.getSnapshot().queue[0];
      if (!item) throw new Error("Expected a queue item");
      expect((await storage.read()).draft).toBeNull();
      editor.newPolygon();
      await editor.restoreQueued(item.sequence);
      expect(editor.getSnapshot().queue[0]).toBe(item);
      await editor.cancel();
      await editor.restoreQueued(item.sequence);
      expect(editor.getSnapshot().queue).toEqual([]);
      expect(editor.getSnapshot().draft).toMatchObject({
        phase: "naming",
        name: "Lane A",
        points,
      });
      await editor.save();
      await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
      expect(transport.mock.calls[2]?.[1]?.headers).not.toEqual(
        transport.mock.calls[1]?.[1]?.headers,
      );
    },
  );

  it("retains a conflict without blocking later requests and discards only that item", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "idempotency_conflict", message: "Conflict" } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json(polygon));
    const { editor, storage } = setup(transport);
    await editor.start();
    draft(editor);
    await editor.save();
    draft(editor);
    await editor.save();
    await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
    const conflict = editor.getSnapshot().queue[0];
    if (!conflict) throw new Error("Expected a queue item");
    expect(conflict).toMatchObject({
      state: { status: "failed", reason: "conflict" },
      submission: { body },
    });
    await editor.restoreQueued(conflict.sequence);
    expect(editor.getSnapshot().draft).toBeNull();
    editor.newPolygon([20, 20]);
    await editor.discardQueued(conflict.sequence);
    expect((await storage.readView()).queue).toEqual([]);
    expect(editor.getSnapshot().draft?.points).toEqual([[20, 20]]);
    expect(editor.getSnapshot().polygons).toEqual([polygon]);
  });

  it("keeps the draft on enqueue failure and issues no POST until its attempt is recorded", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json(polygon));
    const { editor, storage } = setup(transport);
    await editor.start();
    draft(editor);
    vi.spyOn(storage, "enqueue").mockRejectedValueOnce(
      new Error("Enqueue failed"),
    );
    await editor.save();
    expect(editor.getSnapshot()).toMatchObject({
      storageError: true,
      draft: { phase: "naming", points },
      queue: [],
    });
    expect((await storage.read()).draft?.phase).toBe("naming");

    vi.spyOn(storage, "updateQueue").mockRejectedValueOnce(
      new Error("Marker failed"),
    );
    await editor.save();
    await expect.poll(() => editor.getSnapshot().queueError).toBe(true);
    expect(editor.getSnapshot()).toMatchObject({
      storageError: false,
      draft: null,
    });
    expect((await storage.readView()).queue[0]?.state).toEqual({
      status: "queued",
    });
    expect(transport).toHaveBeenCalledTimes(1);

    await editor.retryQueue();
    await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("commits a held create result before replay after an acknowledgment storage failure", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json(polygon, { status: 201 }));
    const { editor, storage } = setup(transport);
    await editor.start();
    draft(editor);
    vi.spyOn(storage, "acknowledgeQueue").mockRejectedValueOnce(
      new Error("Ack failed"),
    );
    await editor.save();
    editor.newPolygon([20, 20]);
    await expect.poll(() => editor.getSnapshot().queueError).toBe(true);
    expect(editor.getSnapshot()).toMatchObject({
      polygons: [],
      queue: [{ state: { status: "sending", attempts: 1 } }],
      draft: { points: [[20, 20]] },
      lastSaved: null,
    });
    const sending = editor.getSnapshot().queue[0];
    if (!sending) throw new Error("Expected a queue item");
    await editor.discardQueued(sending.sequence);
    expect(editor.getSnapshot().queue[0]).toBe(sending);
    await editor.retryQueue();
    expect(editor.getSnapshot()).toMatchObject({
      queueError: false,
      queue: [],
      polygons: [polygon],
      draft: { points: [[20, 20]] },
      lastSaved: { sequence: sending.sequence, name: polygon.name },
    });
    expect((await storage.read()).draft?.points).toEqual([[20, 20]]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("suppresses a stale freeze and autosave until the losing tab reloads", async () => {
    const response = deferred<Response>();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]))
      .mockReturnValueOnce(response.promise);
    const { editor, make, storage } = setup(transport);
    await editor.start();
    draft(editor);
    await expect
      .poll(async () => (await storage.read()).draft?.name)
      .toBe(" \u0085Lane A\uFEFF ");
    const loser = make();
    await loser.start();
    const saving = editor.save();
    await expect.poll(() => transport.mock.calls.length).toBe(3);
    await loser.save();
    expect(loser.getSnapshot()).toMatchObject({
      stale: true,
      draft: { phase: "naming", points },
    });
    loser.setName("Losing edit");
    expect(transport).toHaveBeenCalledTimes(3);
    response.resolve(Response.json(polygon, { status: 201 }));
    await saving;
    await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
    expect((await storage.read()).draft).toBeNull();
    await loser.reloadWorkspace();
    expect(loser.getSnapshot()).toMatchObject({
      stale: false,
      draft: null,
      imageStatus: "ready",
    });
    draft(loser);
    await expect
      .poll(async () => (await storage.read()).draft?.phase)
      .toBe("naming");
  });
});

describe("workspace recovery boundaries", () => {
  it("flushes queued edits before explicitly reloading the workspace", async () => {
    const { editor, storage } = setup();
    await editor.start();
    const release = deferred<undefined>();
    const write = storage.write.bind(storage);
    const held = vi
      .spyOn(storage, "write")
      .mockImplementationOnce(async (expected, change) => {
        await release.promise;
        return write(expected, change);
      });
    const read = vi.spyOn(storage, "read");
    editor.newPolygon();
    editor.addPoint(points[0]);
    const reloading = editor.reloadWorkspace();
    try {
      expect(read).not.toHaveBeenCalled();
      expect(editor.getSnapshot()).toMatchObject({
        imageStatus: "loading",
        draftPending: true,
        draft: { phase: "drawing", points: [[10, 10]] },
      });
    } finally {
      release.resolve(undefined);
      await reloading;
    }
    expect(held).toHaveBeenCalledTimes(2);
    expect(editor.getSnapshot()).toMatchObject({
      imageStatus: "ready",
      draftPending: false,
      draft: { phase: "drawing", points: [[10, 10]] },
    });
  });

  it("retries an initial storage read failure independently of a loaded list", async () => {
    const { editor, storage } = setup();
    vi.spyOn(storage, "read").mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    await editor.start();
    expect(editor.getSnapshot()).toMatchObject({
      imageStatus: "error",
      storageError: true,
      listStatus: "ready",
    });
    await editor.retryImage();
    expect(editor.getSnapshot()).toMatchObject({
      imageStatus: "ready",
      storageError: false,
    });
  });

  it("adopts a concurrent image replacement only after explicit reload", async () => {
    const { editor, make, database, storage, fetchImage } = setup();
    await editor.start();
    const image = imageId(await storage.read());
    await setCachedImage(database, image);
    const first = make();
    const stale = make();
    await Promise.all([first.start(), stale.start()]);
    await first.retryImage();
    await stale.retryImage();
    expect(stale.getSnapshot()).toMatchObject({
      imageStatus: "error",
      stale: true,
      storageError: false,
    });
    await stale.retryImage();
    expect(fetchImage).toHaveBeenCalledTimes(3);
    await stale.reloadWorkspace();
    expect(stale.getSnapshot()).toMatchObject({
      imageStatus: "ready",
      stale: false,
    });
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });

  it("does not send while the last queued edit fails and lets the user retry", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json(polygon, { status: 201 }));
    const { editor, storage } = setup(transport);
    await editor.start();
    draft(editor);
    await expect
      .poll(async () => (await storage.read()).draft?.phase)
      .toBe("naming");
    editor.setName("");
    await editor.save();
    expect(editor.getSnapshot().saveStatus).toBe("invalid");
    await expect.poll(() => editor.getSnapshot().draftPending).toBe(false);
    expect((await storage.read()).draft?.name).toBe("");
    vi.spyOn(storage, "write").mockRejectedValueOnce(new Error("Write failed"));
    editor.setName("Lane A");
    await editor.save();
    expect(editor.getSnapshot()).toMatchObject({
      storageError: true,
      draft: { name: "Lane A" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    await editor.save();
    await expect.poll(() => editor.getSnapshot().polygons).toEqual([polygon]);
    expect(editor.getSnapshot()).toMatchObject({
      storageError: false,
      draft: null,
    });
  });
});

it("persists moved vertices in editable drafts and guards invalid saves", async () => {
  const send = vi.fn(() => Promise.resolve(Response.json([])));
  const { editor, storage, make } = setup(send);
  await editor.start();
  editor.movePoint(0, [20, 20]);
  editor.newPolygon();
  for (const point of points) editor.addPoint(point);
  editor.movePoint(8, [20, 20]);
  editor.movePoint(0, [10, 10]);
  editor.movePoint(0, [-1, 20]);
  editor.movePoint(0, [20, 1081]);
  expect(editor.getSnapshot().draft?.points).toEqual(points);
  editor.movePoint(0, [20, 20]);
  editor.finish();
  editor.setName("Lane A");
  editor.movePoint(2, [20, 20]);
  await editor.save();
  expect(editor.getSnapshot().saveStatus).toBe("invalid");
  expect(send).toHaveBeenCalledOnce();

  editor.movePoint(2, [110, 120]);
  await expect
    .poll(async () => (await storage.read()).draft?.points)
    .toEqual([
      [20, 20],
      [100, 10],
      [110, 120],
    ]);
  const restored = make();
  await restored.start();
  expect(restored.getSnapshot().draft).toMatchObject({
    phase: "naming",
    name: "Lane A",
    points: [
      [20, 20],
      [100, 10],
      [110, 120],
    ],
  });
});

describe("persistent polygon list", () => {
  it("writes confirmed list, save and delete results to the browser cache", async () => {
    const second = { ...polygon, id: 8 };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([polygon]))
      .mockResolvedValueOnce(Response.json(second, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { editor, storage } = setup(transport);
    await editor.start();
    await expect.poll(() => storage.readPolygons()).toEqual([polygon]);
    draft(editor);
    await editor.save();
    await expect.poll(() => storage.readPolygons()).toEqual([polygon, second]);
    editor.newPolygon([20, 20]);
    await expect
      .poll(async () => (await storage.read()).draft?.points)
      .toEqual([[20, 20]]);
    const workspace = await storage.read();
    const otherTab = { ...polygon, id: 9 };
    await storage.writePolygons({ snapshot: [polygon, second, otherTab] });
    expect(await storage.read()).toEqual(workspace);
    await editor.deletePolygon(polygon.id);
    await expect.poll(() => storage.readPolygons()).toEqual([second, otherTab]);
  });

  it("holds the API lock until the confirmed list cache commits", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([polygon]))
      .mockResolvedValueOnce(Response.json([polygon]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { editor, make, storage } = setup(transport);
    const second = make();
    await second.start();
    const release = deferred<undefined>();
    const write = storage.writePolygons.bind(storage);
    const writes = vi
      .spyOn(storage, "writePolygons")
      .mockImplementationOnce(async (change) => {
        await release.promise;
        await write(change);
      });
    const starting = editor.start();
    await expect.poll(() => writes.mock.calls.length).toBe(1);
    const deleting = second.deletePolygon(polygon.id);
    expect(transport).toHaveBeenCalledTimes(2);
    release.resolve(undefined);
    await Promise.all([starting, deleting]);
    expect(await storage.readPolygons()).toEqual([]);
    expect(second.getSnapshot().polygons).toEqual([]);
  });

  it("does not overwrite a committed server result with a late atomic view", async () => {
    const { editor, storage } = setup(() =>
      Promise.resolve(Response.json([polygon])),
    );
    const previous = await storage.readView();
    const older = deferred<typeof previous>();
    vi.spyOn(storage, "readView").mockReturnValueOnce(older.promise);
    const starting = editor.start();
    await expect.poll(() => editor.getSnapshot().listLoaded).toBe(true);
    older.resolve({ ...previous, polygons: [{ ...polygon, id: 6 }] });
    await starting;
    expect(editor.getSnapshot()).toMatchObject({
      listLoaded: true,
      listFromCache: false,
      polygons: [polygon],
    });
  });

  it("keeps the confirmed view when a newer server list fails to commit", async () => {
    const { editor, storage } = setup(() =>
      Promise.resolve(Response.json([polygon])),
    );
    await editor.start();
    vi.spyOn(storage, "writePolygons").mockRejectedValueOnce(
      new Error("Cache write failed"),
    );
    await editor.refreshList();
    expect(editor.getSnapshot()).toMatchObject({
      listLoaded: true,
      listStatus: "error",
      polygons: [polygon],
      storageError: false,
    });
  });
});
