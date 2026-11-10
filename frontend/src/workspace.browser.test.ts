import { describe, expect, it, vi } from "vitest";

import {
  BrowserWorkspaceStore,
  RevisionConflict,
  randomId,
  type EditableDraft,
  type SubmittedDraft,
  type Workspace,
} from "./workspace";

const drawing = {
  id: "first draft",
  phase: "drawing",
  name: "",
  points: [],
} as const;
const firstImage = { id: "first image", blob: new Blob(["first"]) };
const secondImage = { id: "second image", blob: new Blob(["second"]) };
const naming = {
  id: "finished draft",
  phase: "naming",
  name: "First polygon",
  points: [
    [5, 5],
    [80, 5],
    [80, 80],
  ],
} as const;
const submission = {
  key: "37101b19-d8f2-4a44-b89e-e81adcb31e83",
  body: { name: naming.name, points: naming.points },
};
const saved = { id: 8, ...submission.body };

async function seedV1(
  name: string,
  draft: EditableDraft | SubmittedDraft,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const workspace = request.result.createObjectStore("workspace");
      const images = request.result.createObjectStore("images");
      workspace.put({ revision: 4, imageId: firstImage.id, draft }, "current");
      workspace.put([saved], "polygons");
      images.put(
        { bytes: new TextEncoder().encode("first").buffer, type: "" },
        firstImage.id,
      );
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("v1 database setup failed"));
    };
  });
}

async function prepareDraft(store: BrowserWorkspaceStore): Promise<Workspace> {
  const current = await store.read();
  const withImage =
    current.imageId === null
      ? await store.write(current, { image: firstImage })
      : current;
  return store.write(withImage, { draft: naming });
}

async function firstQueueItem(store: BrowserWorkspaceStore) {
  const item = (await store.readView()).queue[0];
  if (!item) throw new Error("Expected a queued submission");
  return item;
}

describe("IndexedDB workspace", () => {
  it("migrates a submitted v1 draft out of the editing slot", async () => {
    const name = randomId();
    await seedV1(name, { ...naming, phase: "submitted", submission });
    const store = new BrowserWorkspaceStore(name);

    expect(await store.read()).toEqual({
      revision: 5,
      imageId: firstImage.id,
      draft: null,
    });
    expect(await store.readPolygons()).toEqual([saved]);
    expect(await (await store.readImage(firstImage.id))?.text()).toBe("first");
    expect((await store.readView()).queue).toEqual([
      {
        sequence: 1,
        revision: 0,
        imageId: firstImage.id,
        submission,
        state: { status: "sending", attempts: 1 },
      },
    ]);
  });

  it("preserves an editable v1 draft and its revision", async () => {
    const name = randomId();
    await seedV1(name, naming);
    const store = new BrowserWorkspaceStore(name);
    expect(await store.readView()).toMatchObject({
      workspace: { revision: 4, imageId: firstImage.id, draft: naming },
      polygons: [saved],
      queue: [],
    });
  });

  it("clears the submitted draft and stores immutable submissions in FIFO order", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    const first = await prepareDraft(store);
    const empty = await store.enqueue(first, submission);
    expect(empty).toEqual({
      ...first,
      revision: first.revision + 1,
      draft: null,
    });

    const second = await prepareDraft(store);
    const nextSubmission = {
      ...submission,
      key: "ee2b3de1-3666-49d1-9954-a1b96958befa",
    };
    const afterSecond = await store.enqueue(second, nextSubmission);
    const view = await store.readView();
    expect(view.workspace).toEqual(afterSecond);
    expect(
      view.queue.map(({ sequence, imageId, submission, state }) => ({
        sequence,
        imageId,
        submission,
        state,
      })),
    ).toEqual([
      {
        sequence: 1,
        imageId: firstImage.id,
        submission,
        state: { status: "queued" },
      },
      {
        sequence: 2,
        imageId: firstImage.id,
        submission: nextSubmission,
        state: { status: "queued" },
      },
    ]);
  });

  it("allows exactly one of two tabs to enqueue the same draft revision", async () => {
    const name = randomId();
    const firstTab = new BrowserWorkspaceStore(name);
    const otherTab = new BrowserWorkspaceStore(name);
    const expected = await prepareDraft(firstTab);
    const otherExpected = await otherTab.read();
    const results = await Promise.allSettled([
      firstTab.enqueue(expected, submission),
      otherTab.enqueue(otherExpected, { ...submission, key: randomId() }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(RevisionConflict);
    expect((await firstTab.readView()).queue).toHaveLength(1);
  });

  it("retains the draft and sequence when the enqueue transaction aborts", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    const expected = await prepareDraft(store);
    const add = Reflect.get(IDBObjectStore.prototype, "add");
    const fail = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = add.call(this, value, key);
        if (this.name === "saveQueue") this.transaction.abort();
        return request;
      });
    try {
      await expect(store.enqueue(expected, submission)).rejects.toThrow();
    } finally {
      fail.mockRestore();
    }
    expect(await store.readView()).toMatchObject({
      workspace: expected,
      queue: [],
      revision: 0,
    });
    await store.enqueue(expected, submission);
    expect((await store.readView()).queue).toMatchObject([{ sequence: 1 }]);
  });

  it("acknowledges a sending request as a receipt without touching the next draft", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    await store.enqueue(await prepareDraft(store), submission);
    const queued = await firstQueueItem(store);
    const sending = await store.updateQueue(queued, {
      status: "sending",
      attempts: 1,
    });
    const nextDraft = { ...drawing, id: "next draft" };
    const newer = await store.write(await store.read(), { draft: nextDraft });
    const before = await store.readView();
    await expect(store.acknowledgeQueue(queued, saved)).rejects.toThrow();
    expect(await store.readView()).toEqual(before);

    await store.acknowledgeQueue(sending, saved);
    expect(await store.readView()).toEqual({
      workspace: newer,
      queue: [],
      receipts: [saved],
      polygons: null,
      revision: before.revision + 1,
    });
    await store.writePolygons({ snapshot: [saved] });
    expect(await store.readView()).toMatchObject({
      receipts: [],
      polygons: [saved],
    });
    await store.writePolygons({ removedId: saved.id });
    expect(await store.readView()).toMatchObject({
      receipts: [],
      polygons: [],
    });
  });

  it("reuses confirmed polygons across queue-only writes and refreshes them after another tab acknowledges", async () => {
    const database = randomId();
    const reader = new BrowserWorkspaceStore(database);
    const writer = new BrowserWorkspaceStore(database);
    await writer.writePolygons({ snapshot: [saved] });
    const initial = await reader.readView();

    await writer.enqueue(await prepareDraft(writer), submission);
    const sending = await writer.updateQueue(await firstQueueItem(writer), {
      status: "sending",
      attempts: 1,
    });
    const during = await reader.readView();
    expect(during.queue).toEqual([sending]);
    expect(during.polygons).toBe(initial.polygons);
    expect(during.receipts).toBe(initial.receipts);

    const confirmed = { ...saved, id: 9 };
    await writer.acknowledgeQueue(sending, confirmed);
    const after = await reader.readView();
    expect(after.queue).toEqual([]);
    expect(after.polygons).toEqual([saved, confirmed]);
    expect(await reader.readPolygons()).toBe(after.polygons);
  });

  it("blocks photo replacement until an image-bound failure is restored", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    const empty = await store.enqueue(await prepareDraft(store), submission);
    const queued = await firstQueueItem(store);
    const failed = await store.updateQueue(queued, {
      status: "failed",
      reason: "invalid",
    });
    await expect(store.write(empty, { image: secondImage })).rejects.toThrow();
    await expect(
      store.restoreQueue(failed, { ...empty, revision: 0 }, "restored"),
    ).rejects.toBeInstanceOf(RevisionConflict);
    const restored = await store.restoreQueue(failed, empty, "restored");
    expect(restored.draft).toEqual({ ...naming, id: "restored" });
    expect((await store.readView()).queue).toEqual([]);
    expect(await (await store.readImage(firstImage.id))?.text()).toBe("first");
  });

  it("discards a paused request without touching another queue entry", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    await store.enqueue(await prepareDraft(store), submission);
    const queued = await firstQueueItem(store);
    const sending = await store.updateQueue(queued, {
      status: "sending",
      attempts: 1,
    });
    const laterSubmission = { ...submission, key: randomId() };
    await store.enqueue(await prepareDraft(store), laterSubmission);

    await expect(store.discardQueue(sending)).rejects.toThrow();
    const paused = await store.updateQueue(sending, { status: "paused" });
    await store.discardQueue(paused);
    expect((await store.readView()).queue).toMatchObject([
      { sequence: 2, submission: laterSubmission },
    ]);
  });

  it("retains the persisted sending marker if acknowledgment aborts", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    await store.enqueue(await prepareDraft(store), submission);
    const sending = await store.updateQueue(await firstQueueItem(store), {
      status: "sending",
      attempts: 1,
    });
    await store.writePolygons({ snapshot: [] });
    const before = await store.readView();
    const remove = Reflect.get(IDBObjectStore.prototype, "delete");
    const fail = vi
      .spyOn(IDBObjectStore.prototype, "delete")
      .mockImplementation(function (
        this: IDBObjectStore,
        key: IDBValidKey | IDBKeyRange,
      ) {
        const request = remove.call(this, key);
        if (this.name === "saveQueue") this.transaction.abort();
        return request;
      });
    try {
      await expect(store.acknowledgeQueue(sending, saved)).rejects.toThrow();
    } finally {
      fail.mockRestore();
    }
    expect(await store.readView()).toEqual(before);
    await store.acknowledgeQueue(sending, saved);
    expect(await store.readView()).toMatchObject({
      polygons: [saved],
      queue: [],
      receipts: [],
    });
  });

  it("accepts only one simultaneous initialization", async () => {
    const name = randomId();
    const a = new BrowserWorkspaceStore(name);
    const b = new BrowserWorkspaceStore(name);
    const [initialA, initialB] = await Promise.all([a.read(), b.read()]);
    expect(initialA).toEqual({ revision: 0, imageId: null, draft: null });
    const writes = await Promise.allSettled([
      a.write(initialA, { image: firstImage }),
      b.write(initialB, { image: secondImage }),
    ]);

    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(RevisionConflict);
    const current = await a.read();
    expect(await b.read()).toEqual(current);
    expect(current.revision).toBe(1);
    const winner = current.imageId === firstImage.id ? firstImage : secondImage;
    const loser = winner === firstImage ? secondImage : firstImage;
    expect(await (await a.readImage(winner.id))?.text()).toBe(
      await winner.blob.text(),
    );
    expect(await b.readImage(loser.id)).toBeNull();
  });

  it("checks draft identity, rejects image replacement during a draft, and retains the revision after clear", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    const imageWorkspace = await store.write(await store.read(), {
      image: firstImage,
    });
    const editing = await store.write(imageWorkspace, { draft: drawing });

    await expect(
      store.write({ ...editing, draft: null }, { draft: null }),
    ).rejects.toBeInstanceOf(RevisionConflict);
    await expect(
      store.write(editing, { image: secondImage }),
    ).rejects.toBeInstanceOf(RevisionConflict);
    const cleared = await store.write(editing, { draft: null });
    expect(cleared).toEqual({
      revision: 3,
      imageId: firstImage.id,
      draft: null,
    });
    await expect(
      store.write(editing, { draft: drawing }),
    ).rejects.toBeInstanceOf(RevisionConflict);

    const replaced = await store.write(cleared, { image: secondImage });
    expect(replaced).toEqual({
      revision: 4,
      imageId: secondImage.id,
      draft: null,
    });
    expect(await store.readImage(firstImage.id)).toBeNull();
    expect(await (await store.readImage(secondImage.id))?.text()).toBe(
      "second",
    );
  });

  it("leaves no partial replacement when the write transaction aborts", async () => {
    const store = new BrowserWorkspaceStore(randomId());
    const existing = await store.write(await store.read(), {
      image: firstImage,
    });
    const put = Reflect.get(IDBObjectStore.prototype, "put");
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = put.call(this, value, key);
        if (this.name === "workspace") this.transaction.abort();
        return request;
      });
    try {
      await expect(
        store.write(existing, { image: secondImage }),
      ).rejects.toThrow("aborted");
    } finally {
      spy.mockRestore();
    }
    expect(await store.read()).toEqual(existing);
    expect(await (await store.readImage(firstImage.id))?.text()).toBe("first");
    expect(await store.readImage(secondImage.id)).toBeNull();
  });

  it("uses independent UUIDv4 identities when randomUUID is unavailable", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID is unavailable on LAN HTTP");
    });
    try {
      const first = randomId();
      const second = randomId();
      expect(first).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      expect(second).not.toBe(first);
    } finally {
      randomUUID.mockRestore();
    }
  });
});

it("rolls back if a request fails asynchronously", async () => {
  const store = new BrowserWorkspaceStore(randomId());
  const existing = await store.write(await store.read(), { image: firstImage });
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementationOnce(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      return this.add(value, key);
    });
  try {
    await expect(
      store.write(existing, { draft: drawing }),
    ).rejects.toMatchObject({
      name: "ConstraintError",
    });
  } finally {
    put.mockRestore();
  }
  expect(await store.read()).toEqual(existing);
});

it("rolls back if preparing a transaction request throws", async () => {
  const store = new BrowserWorkspaceStore(randomId());
  const existing = await store.write(await store.read(), { image: firstImage });
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementationOnce(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
  try {
    await expect(store.write(existing, { draft: drawing })).rejects.toThrow(
      "Storage quota exceeded",
    );
  } finally {
    put.mockRestore();
  }
  expect(await store.read()).toEqual(existing);
});

it("reports read and database-open errors so callers can retry", async () => {
  const name = randomId();
  const store = new BrowserWorkspaceStore(name);
  const expected = await store.write(await store.read(), { image: firstImage });
  const get = Reflect.get(IDBObjectStore.prototype, "get");
  const read = vi
    .spyOn(IDBObjectStore.prototype, "get")
    .mockImplementationOnce(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      const request = get.call(this, key);
      this.transaction.abort();
      return request;
    });
  try {
    await expect(store.read()).rejects.toThrow();
  } finally {
    read.mockRestore();
  }
  expect(await store.read()).toEqual(expected);

  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(name, 3);
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      reject(open.error ?? new Error("Upgrade failed"));
    };
  });
  upgraded.close();
  await expect(store.read()).rejects.toThrow();
});
