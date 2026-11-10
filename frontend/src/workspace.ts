import {
  mergePolygons,
  parsePolygonList,
  type Polygon,
  type Submission,
} from "./api";
import type { Point } from "./geometry";
import { sameQueueVersion, type QueueItem } from "./saveQueue";

type DraftContent = {
  readonly id: string;
  readonly points: readonly Point[];
  readonly name: string;
};

export type EditableDraft = DraftContent & {
  readonly phase: "drawing" | "naming";
};
export type SubmittedDraft = DraftContent & {
  readonly phase: "submitted";
  readonly submission: Submission;
};

export type Workspace = {
  readonly revision: number;
  readonly imageId: string | null;
  readonly draft: EditableDraft | null;
};

type LegacyWorkspace = Omit<Workspace, "draft"> & {
  readonly draft: EditableDraft | SubmittedDraft | null;
};

export type WorkspaceChange =
  { draft: EditableDraft | null } | { image: { id: string; blob: Blob } };

export type PolygonCacheChange =
  { snapshot: readonly Polygon[] } | { saved: Polygon } | { removedId: number };

export type WorkspaceView = Readonly<{
  revision: number;
  workspace: Workspace;
  polygons: readonly Polygon[] | null;
  receipts: readonly Polygon[];
  queue: readonly QueueItem[];
}>;

export interface WorkspaceStore {
  readonly coordinationKey: string;
  read(): Promise<Workspace>;
  readView(): Promise<WorkspaceView>;
  readImage(id: string): Promise<Blob | null>;
  readPolygons(): Promise<readonly Polygon[] | null>;
  writePolygons(change: PolygonCacheChange): Promise<void>;
  write(expected: Workspace, change: WorkspaceChange): Promise<Workspace>;
  enqueue(expected: Workspace, submission: Submission): Promise<Workspace>;
  updateQueue(
    expected: QueueItem,
    state: QueueItem["state"],
  ): Promise<QueueItem>;
  acknowledgeQueue(expected: QueueItem, polygon: Polygon): Promise<void>;
  discardQueue(expected: QueueItem): Promise<void>;
  restoreQueue(
    expected: QueueItem,
    workspace: Workspace,
    draftId: string,
  ): Promise<Workspace>;
}

type StoredImage = { bytes: ArrayBuffer; type: string };
type ConfirmedCollection = Pick<WorkspaceView, "polygons" | "receipts"> & {
  readonly revision: number;
};
type Transaction<T> = {
  store: (name: string) => IDBObjectStore;
  after: <Value>(
    request: IDBRequest<Value>,
    run: (value: unknown) => void,
  ) => void;
  finish: (value: T) => void;
};

const WORKSPACE = "workspace";
const CURRENT = "current";
const IMAGES = "images";
const POLYGONS = "polygons";
const QUEUE = "saveQueue";
const RECEIPTS = "receipts";
const VIEW_REVISION = "viewRevision";
const CONFIRMED_REVISION = "confirmedRevision";
const EMPTY: Workspace = { revision: 0, imageId: null, draft: null };

function storedRevision(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function storedWorkspace(value: unknown): Workspace {
  return (value as Workspace | undefined) ?? EMPTY;
}

function storedImage(value: unknown): Blob | null {
  if (value instanceof Blob) return value;
  const { bytes, type } = (value ?? {}) as Partial<StoredImage>;
  return bytes instanceof ArrayBuffer && typeof type === "string"
    ? new Blob([bytes], { type })
    : null;
}

export function sameWorkspaceVersion(
  first: Workspace,
  second: Workspace,
): boolean {
  return (
    first.revision === second.revision && first.draft?.id === second.draft?.id
  );
}

export class RevisionConflict extends Error {
  constructor() {
    super("The workspace has changed in another tab.");
  }
}

export class QueueConflict extends Error {
  constructor() {
    super("The save request has changed in another tab.");
  }
}

export function randomId(): string {
  // getRandomValues is also available when the editor is served over LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class BrowserWorkspaceStore implements WorkspaceStore {
  private confirmed: ConfirmedCollection | undefined;

  constructor(readonly coordinationKey = "notraffic") {}

  async read(): Promise<Workspace> {
    return storedWorkspace(await this.readValue(WORKSPACE, CURRENT));
  }

  async readImage(id: string): Promise<Blob | null> {
    return storedImage(await this.readValue(IMAGES, id));
  }

  readPolygons(): Promise<readonly Polygon[] | null> {
    return this.transact([WORKSPACE], "readonly", (transaction) => {
      this.readConfirmed(transaction, ({ polygons }) => {
        transaction.finish(polygons);
      });
    });
  }

  readView(): Promise<WorkspaceView> {
    return this.transact([WORKSPACE, QUEUE], "readonly", (transaction) => {
      const { store, finish } = transaction;
      const workspace = store(WORKSPACE);
      const current = workspace.get(CURRENT);
      const queue = store(QUEUE).getAll();
      const revision = workspace.get(VIEW_REVISION);
      this.readConfirmed(transaction, ({ polygons, receipts }) => {
        finish({
          revision: storedRevision(revision.result),
          workspace: storedWorkspace(current.result),
          polygons,
          receipts,
          queue: queue.result as QueueItem[],
        });
      });
    });
  }

  writePolygons(change: PolygonCacheChange): Promise<void> {
    return this.writeView([], (transaction) => {
      this.changePolygons(transaction, change, () => {
        transaction.finish();
      });
    });
  }

  enqueue(expected: Workspace, submission: Submission): Promise<Workspace> {
    return this.writeView([QUEUE], ({ store, after, finish }) => {
      const workspace = store(WORKSPACE);
      after(workspace.get(CURRENT), (value) => {
        const current = storedWorkspace(value);
        if (
          !sameWorkspaceVersion(current, expected) ||
          current.draft?.phase !== "naming" ||
          current.imageId === null
        ) {
          throw new RevisionConflict();
        }

        const next = {
          ...current,
          revision: current.revision + 1,
          draft: null,
        };
        workspace.put(next, CURRENT);
        store(QUEUE).add({
          imageId: current.imageId,
          submission,
          revision: 0,
          state: { status: "queued" },
        } satisfies Omit<QueueItem, "sequence">);
        finish(next);
      });
    });
  }

  updateQueue(
    expected: QueueItem,
    state: QueueItem["state"],
  ): Promise<QueueItem> {
    return this.mutateQueue(expected, ({ store, finish }, item) => {
      const next = { ...item, state, revision: item.revision + 1 };
      store(QUEUE).put(next);
      finish(next);
    });
  }

  acknowledgeQueue(expected: QueueItem, polygon: Polygon): Promise<void> {
    return this.mutateQueue(expected, (transaction, item) => {
      if (item.state.status !== "sending") throw new QueueConflict();
      this.changePolygons(transaction, { saved: polygon }, () => {
        transaction.store(QUEUE).delete(item.sequence);
        transaction.finish();
      });
    });
  }

  discardQueue(expected: QueueItem): Promise<void> {
    return this.mutateQueue(expected, ({ store, finish }, item) => {
      const { status } = item.state;
      if (status !== "paused" && status !== "failed") throw new QueueConflict();
      store(QUEUE).delete(item.sequence);
      finish();
    });
  }

  restoreQueue(
    expected: QueueItem,
    expectedWorkspace: Workspace,
    draftId: string,
  ): Promise<Workspace> {
    return this.mutateQueue(
      expected,
      ({ store, after, finish }, item) => {
        if (
          item.state.status !== "failed" ||
          item.state.reason === "conflict"
        ) {
          throw new QueueConflict();
        }
        const workspace = store(WORKSPACE);
        after(workspace.get(CURRENT), (value) => {
          const current = storedWorkspace(value);
          if (
            !sameWorkspaceVersion(current, expectedWorkspace) ||
            current.draft
          ) {
            throw new RevisionConflict();
          }
          if (item.imageId === null || current.imageId !== item.imageId) {
            throw new Error("The original photo is unavailable.");
          }
          after(store(IMAGES).get(item.imageId), (image) => {
            if (!storedImage(image))
              throw new Error("The original photo is unavailable.");
            const next: Workspace = {
              ...current,
              revision: current.revision + 1,
              draft: { ...item.submission.body, id: draftId, phase: "naming" },
            };
            workspace.put(next, CURRENT);
            store(QUEUE).delete(item.sequence);
            finish(next);
          });
        });
      },
      [IMAGES],
    );
  }

  async write(
    expected: Workspace,
    change: WorkspaceChange,
  ): Promise<Workspace> {
    // WebKit can fail to prepare native Blobs for IndexedDB. Store their exact bytes and media type.
    const update =
      "image" in change
        ? {
            image: {
              id: change.image.id,
              data: {
                bytes: await change.image.blob.arrayBuffer(),
                type: change.image.blob.type,
              },
            },
          }
        : change;
    const stores = "image" in update ? [WORKSPACE, IMAGES, QUEUE] : [WORKSPACE];
    return this.transact(stores, "readwrite", ({ store, after, finish }) => {
      const workspace = store(WORKSPACE);
      after(workspace.get(CURRENT), (value) => {
        const current = storedWorkspace(value);
        if (!sameWorkspaceVersion(current, expected))
          throw new RevisionConflict();
        const revision = current.revision + 1;
        if ("draft" in update) {
          const next = { ...current, revision, draft: update.draft };
          workspace.put(next, CURRENT);
          finish(next);
          return;
        }

        if (current.draft !== null) throw new RevisionConflict();
        after(store(QUEUE).index("imageId").count(), (count) => {
          if (count !== 0) {
            throw new Error(
              "Resolve the save queue before replacing the photo.",
            );
          }
          const images = store(IMAGES);
          const { id, data } = update.image;
          if (current.imageId !== null) images.delete(current.imageId);
          images.put(data, id);
          const next = { ...current, revision, imageId: id };
          workspace.put(next, CURRENT);
          finish(next);
        });
      });
    });
  }

  private changePolygons<T>(
    transaction: Transaction<T>,
    change: PolygonCacheChange,
    done: () => void,
  ): void {
    const { store, after } = transaction;
    const workspace = store(WORKSPACE);
    const commit = (revision: number) => {
      workspace.put(revision + 1, CONFIRMED_REVISION);
      done();
    };
    if ("snapshot" in change) {
      after(workspace.get(CONFIRMED_REVISION), (revision) => {
        workspace.put(change.snapshot, POLYGONS);
        workspace.delete(RECEIPTS);
        commit(storedRevision(revision));
      });
      return;
    }

    this.readConfirmed(transaction, ({ revision, polygons, receipts }) => {
      if ("saved" in change) {
        workspace.put(
          mergePolygons(polygons ?? receipts, [change.saved]),
          polygons ? POLYGONS : RECEIPTS,
        );
      } else {
        const keep = ({ id }: Polygon) => id !== change.removedId;
        if (polygons) workspace.put(polygons.filter(keep), POLYGONS);
        if (receipts.length > 0) workspace.put(receipts.filter(keep), RECEIPTS);
      }
      commit(revision);
    });
  }

  private readConfirmed<T>(
    { store, after }: Transaction<T>,
    done: (confirmed: ConfirmedCollection) => void,
  ): void {
    const workspace = store(WORKSPACE);
    after(workspace.get(CONFIRMED_REVISION), (value) => {
      const revision = storedRevision(value);
      if (this.confirmed?.revision === revision) {
        done(this.confirmed);
        return;
      }
      const polygons = workspace.get(POLYGONS);
      after(workspace.get(RECEIPTS), (receipts) => {
        const confirmed = {
          revision,
          polygons: parsePolygonList(polygons.result),
          receipts: parsePolygonList(receipts) ?? [],
        };
        // Cache persisted inputs only. A later write in this transaction can still abort.
        if (!this.confirmed || this.confirmed.revision < revision)
          this.confirmed = confirmed;
        done(confirmed);
      });
    });
  }

  private mutateQueue<T>(
    expected: QueueItem,
    change: (transaction: Transaction<T>, item: QueueItem) => void,
    extraStores: string[] = [],
  ): Promise<T> {
    return this.writeView([QUEUE, ...extraStores], (transaction) => {
      const { store, after } = transaction;
      after(store(QUEUE).get(expected.sequence), (value) => {
        const item = value as QueueItem | undefined;
        if (!item || !sameQueueVersion(expected, item))
          throw new QueueConflict();
        change(transaction, item);
      });
    });
  }

  private writeView<T>(
    extraStores: string[],
    change: (transaction: Transaction<T>) => void,
  ): Promise<T> {
    return this.transact(
      [WORKSPACE, ...extraStores],
      "readwrite",
      (transaction) => {
        const { store, after } = transaction;
        const workspace = store(WORKSPACE);
        after(workspace.get(VIEW_REVISION), (value) => {
          workspace.put(storedRevision(value) + 1, VIEW_REVISION);
          change(transaction);
        });
      },
    );
  }

  private readValue(name: string, key: string): Promise<unknown> {
    return this.transact([name], "readonly", ({ store, after, finish }) => {
      after(store(name).get(key), finish);
    });
  }

  private async transact<T>(
    stores: string[],
    mode: IDBTransactionMode,
    run: (transaction: Transaction<T>) => void,
  ): Promise<T> {
    return this.withDatabase(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(stores, mode);
          let result: T;
          let failure: Error | undefined;
          const attempt = (run: () => void) => {
            try {
              run();
            } catch (error) {
              try {
                transaction.abort();
                failure =
                  error instanceof Error
                    ? error
                    : new Error("Workspace transaction failed", {
                        cause: error,
                      });
              } catch {
                // An aborted transaction already has an outcome.
              }
            }
          };
          transaction.oncomplete = () => {
            resolve(result);
          };
          transaction.onabort = () => {
            reject(
              failure ??
                transaction.error ??
                new Error("Workspace transaction aborted"),
            );
          };
          attempt(() => {
            run({
              store: (name) => transaction.objectStore(name),
              // Issue subsequent requests in IDB's active event, including in WebKit.
              after: (request, next) => {
                request.onsuccess = () => {
                  attempt(() => {
                    next(request.result);
                  });
                };
              },
              finish: (value) => {
                result = value;
              },
            });
          });
        }),
    );
  }

  private async withDatabase<T>(
    run: (database: IDBDatabase) => Promise<T>,
  ): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.coordinationKey, 2);
      request.onupgradeneeded = ({ oldVersion }) => {
        const database = request.result;
        if (oldVersion === 0) {
          this.confirmed = undefined;
          database.createObjectStore(WORKSPACE);
          database.createObjectStore(IMAGES);
        }
        const queue = database.createObjectStore(QUEUE, {
          keyPath: "sequence",
          autoIncrement: true,
        });
        queue.createIndex("imageId", "imageId");
        if (oldVersion === 1 && request.transaction) {
          const workspace = request.transaction.objectStore(WORKSPACE);
          const read = workspace.get(CURRENT);
          read.onsuccess = () => {
            const current = read.result as LegacyWorkspace | undefined;
            if (current?.draft?.phase !== "submitted") return;
            queue.add({
              imageId: current.imageId,
              submission: current.draft.submission,
              revision: 0,
              state: { status: "sending", attempts: 1 },
            } satisfies Omit<QueueItem, "sequence">);
            workspace.put(
              {
                ...current,
                revision: current.revision + 1,
                draft: null,
              },
              CURRENT,
            );
            workspace.put(1, VIEW_REVISION);
          };
        }
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("Workspace open failed", { cause: request.error }));
      };
    });
    try {
      return await run(database);
    } finally {
      database.close();
    }
  }
}
