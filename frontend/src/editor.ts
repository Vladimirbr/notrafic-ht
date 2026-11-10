import { mergePolygons, PolygonApi, type Polygon } from "./api";
import {
  MAX_VERTICES,
  inImageBounds,
  normalizeName,
  validDraftContour,
  type Point,
} from "./geometry";
import { sameQueueVersion, type QueueItem } from "./saveQueue";
import { SaveQueueWorker, type SavedQueueNotice } from "./saveQueueWorker";
import { decodePicture, fetchPicture } from "./sceneImage";
import {
  BrowserWorkspaceStore,
  QueueConflict,
  RevisionConflict,
  randomId,
  type EditableDraft,
  type Workspace,
  type WorkspaceStore,
  type WorkspaceView,
} from "./workspace";

type ImageStatus = "loading" | "ready" | "error" | "missing";
type ListStatus = "loading" | "ready" | "error";
type Operation = "list" | "delete";

export type EditorSnapshot = Readonly<{
  image: HTMLImageElement | null;
  imageId: string | null;
  imageStatus: ImageStatus;
  listStatus: ListStatus;
  listLoaded: boolean;
  listFromCache: boolean;
  polygons: readonly Polygon[];
  draft: EditableDraft | null;
  draftPending: boolean;
  discarding: boolean;
  restoring: boolean;
  enqueueing: boolean;
  queue: readonly QueueItem[];
  queueAvailable: boolean;
  queueError: boolean;
  lastSaved: SavedQueueNotice | null;
  operation: Operation | null;
  deletingId: number | null;
  stale: boolean;
  storageError: boolean;
  saveStatus: "idle" | "invalid";
  deleteError: boolean;
}>;

type EditorOptions = {
  storage?: WorkspaceStore;
  api?: Pick<PolygonApi, "list" | "save" | "delete">;
  fetchImage?: typeof fetch;
};

export function canEditDraft(
  state: Pick<
    EditorSnapshot,
    "imageStatus" | "enqueueing" | "discarding" | "restoring" | "stale"
  >,
): boolean {
  return (
    state.imageStatus === "ready" &&
    !state.enqueueing &&
    !state.discarding &&
    !state.restoring &&
    !state.stale
  );
}

function retainQueue(
  previous: readonly QueueItem[],
  current: readonly QueueItem[],
): readonly QueueItem[] {
  const bySequence = new Map(previous.map((item) => [item.sequence, item]));
  const next = current.map((item) => {
    const old = bySequence.get(item.sequence);
    if (!old || old.submission.key !== item.submission.key) return item;
    if (sameQueueVersion(old, item)) return old;
    return { ...item, submission: old.submission };
  });
  return next.length === previous.length &&
    next.every((item, index) => item === previous[index])
    ? previous
    : next;
}

function retainPolygons(
  previous: readonly Polygon[],
  current: readonly Polygon[],
): readonly Polygon[] {
  const byId = new Map(previous.map((polygon) => [polygon.id, polygon]));
  const next = current.map((polygon) => {
    const old = byId.get(polygon.id);
    if (
      !old ||
      old.name !== polygon.name ||
      old.points.length !== polygon.points.length ||
      !old.points.every(([x, y], index) => {
        const point = polygon.points[index];
        return point?.[0] === x && point[1] === y;
      })
    )
      return polygon;
    return old;
  });
  return next.length === previous.length &&
    next.every((polygon, index) => polygon === previous[index])
    ? previous
    : next;
}

function imageBound(queue: readonly QueueItem[]): boolean {
  return queue.some(({ imageId }) => imageId !== null);
}

export class Editor {
  private state: EditorSnapshot = {
    image: null,
    imageId: null,
    imageStatus: "loading",
    listStatus: "loading",
    listLoaded: false,
    listFromCache: false,
    polygons: [],
    draft: null,
    draftPending: false,
    discarding: false,
    restoring: false,
    enqueueing: false,
    queue: [],
    queueAvailable: false,
    queueError: false,
    lastSaved: null,
    operation: null,
    deletingId: null,
    stale: false,
    storageError: false,
    saveStatus: "idle",
    deleteError: false,
  };

  private readonly storage: WorkspaceStore;
  private readonly api: NonNullable<EditorOptions["api"]>;
  private readonly fetchImage: typeof fetch;
  private readonly worker: SaveQueueWorker;
  private readonly listeners = new Set<() => void>();
  private current: Workspace | null = null;
  private view: WorkspaceView | null = null;
  private startup: Promise<void> | null = null;
  private writes = Promise.resolve();
  private imageLoading = false;

  constructor({
    storage = new BrowserWorkspaceStore(),
    api = new PolygonApi(),
    fetchImage = (input, init) => fetch(input, init),
  }: EditorOptions = {}) {
    this.storage = storage;
    this.api = api;
    this.fetchImage = fetchImage;
    this.worker = new SaveQueueWorker({
      storage,
      api,
      readView: (lastSaved) =>
        this.readDeliveryView(lastSaved ? { lastSaved } : {}),
      onError: (queueError) => {
        this.update({ queueError });
      },
    });
    this.state = { ...this.state, queueAvailable: this.worker.available };
  }

  getSnapshot = (): EditorSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): Promise<void> {
    this.startup ??= Promise.all([
      this.loadImage("start"),
      this.worker.start(),
      this.refreshList(),
    ]).then(() => undefined);
    return this.startup;
  }

  async refreshList(): Promise<void> {
    if (!this.begin("list")) return;
    try {
      await this.worker.exclusive(async () => {
        const polygons = await this.api.list();
        if (polygons === null) {
          this.update({ listStatus: "error" });
          return;
        }
        await this.storage.writePolygons({ snapshot: polygons });
        this.worker.announce();
        await this.readDeliveryView({
          listStatus: "ready",
          listLoaded: true,
          listFromCache: false,
          deleteError: false,
        });
      });
    } catch {
      this.update({ listStatus: "error" });
    } finally {
      this.end();
    }
  }

  async retryImage(): Promise<void> {
    if (this.state.imageStatus !== "ready" && !this.state.stale)
      await this.loadImage("retry");
  }

  async reloadWorkspace(): Promise<void> {
    await this.loadImage("reload");
  }

  newPolygon(firstPoint?: Point): void {
    if (canEditDraft(this.state) && this.state.draft === null) {
      if (firstPoint && !inImageBounds(firstPoint)) return;
      this.edit({
        id: randomId(),
        phase: "drawing",
        points: firstPoint ? [firstPoint] : [],
        name: "",
      });
    }
  }

  addPoint([x, y]: Point): void {
    const draft = this.editable("drawing");
    if (draft && draft.points.length < MAX_VERTICES && inImageBounds([x, y])) {
      this.edit({ ...draft, points: [...draft.points, [x, y]] });
    }
  }

  movePoint(index: number, [x, y]: Point): void {
    const { draft } = this.state;
    if (!draft || !canEditDraft(this.state)) return;
    const point = draft.points[index];
    if (!point || !inImageBounds([x, y])) return;
    if (point[0] === x && point[1] === y) return;
    const points = draft.points.slice();
    points[index] = [x, y];
    this.edit({ ...draft, points });
  }

  undo(): void {
    const draft = this.editable("drawing");
    if (draft && draft.points.length > 0)
      this.edit({ ...draft, points: draft.points.slice(0, -1) });
  }

  finish(): void {
    const draft = this.editable("drawing");
    if (draft && validDraftContour(draft.points))
      this.edit({ ...draft, phase: "naming" });
  }

  setName(name: string): void {
    const draft = this.editable("naming");
    if (draft && draft.name !== name) this.edit({ ...draft, name });
  }

  back(): void {
    const draft = this.editable("naming");
    if (draft) this.edit({ ...draft, phase: "drawing" });
  }

  async cancel(): Promise<void> {
    if (
      this.state.draft === null ||
      this.state.discarding ||
      this.state.enqueueing ||
      this.state.restoring ||
      this.state.stale
    )
      return;
    this.update({ discarding: true });
    try {
      await this.writes;
      if (await this.persist(null)) {
        this.update({
          draft: null,
          saveStatus: "idle",
          imageStatus:
            this.state.imageStatus === "missing" &&
            !imageBound(this.state.queue)
              ? "error"
              : this.state.imageStatus,
        });
      }
    } finally {
      this.update({ discarding: false });
    }
  }

  async save(): Promise<void> {
    const draft = this.editable("naming");
    if (!draft || !this.worker.available) return;
    const name = normalizeName(draft.name);
    if (!name || !validDraftContour(draft.points)) {
      this.update({ saveStatus: "invalid" });
      return;
    }

    const hadStorageError = this.state.storageError;
    this.update({ enqueueing: true });
    try {
      await this.writes;
      if (!this.current || this.state.stale) return;
      if (this.state.storageError) {
        if (!hadStorageError || !(await this.persist(draft))) return;
      }
      try {
        this.current = await this.storage.enqueue(this.current, {
          key: randomId(),
          body: { name, points: draft.points },
        });
      } catch (error) {
        this.storageFailure(error);
        return;
      }
      await this.applyCommittedView({
        draft: null,
        saveStatus: "idle",
        storageError: false,
      });
    } finally {
      this.update({ enqueueing: false });
    }
  }

  retryQueue(): Promise<void> {
    return this.worker.retry();
  }

  async discardQueued(sequence: number): Promise<void> {
    const item = this.state.queue.find((entry) => entry.sequence === sequence);
    if (
      !item ||
      !this.worker.available ||
      (item.state.status !== "paused" && item.state.status !== "failed")
    )
      return;
    try {
      await this.worker.exclusive(async () => {
        const { queue } = await this.readDeliveryView();
        if (
          !sameQueueVersion(
            item,
            queue.find((entry) => entry.sequence === sequence),
          )
        )
          return;
        await this.storage.discardQueue(item);
        await this.applyCommittedView({});
      });
    } catch (error) {
      if (!(error instanceof QueueConflict)) this.worker.pause();
    }
  }

  async restoreQueued(sequence: number): Promise<void> {
    const item = this.state.queue.find((entry) => entry.sequence === sequence);
    if (
      !item ||
      !this.worker.available ||
      item.state.status !== "failed" ||
      item.state.reason === "conflict" ||
      this.state.draft !== null ||
      !canEditDraft(this.state) ||
      item.imageId !== this.state.imageId
    )
      return;

    try {
      await this.worker.exclusive(async () => {
        const { queue, workspace } = await this.readDeliveryView();
        if (
          !sameQueueVersion(
            item,
            queue.find((entry) => entry.sequence === sequence),
          ) ||
          this.state.draft !== null ||
          !canEditDraft(this.state) ||
          item.imageId !== this.state.imageId
        )
          return;
        if (workspace.draft !== null) {
          this.storageFailure(new RevisionConflict());
          return;
        }
        this.update({ restoring: true });
        try {
          this.current = await this.storage.restoreQueue(
            item,
            workspace,
            randomId(),
          );
          await this.applyCommittedView({
            draft: this.current.draft,
            saveStatus: "idle",
            storageError: false,
          });
        } finally {
          this.update({ restoring: false });
        }
      });
    } catch (error) {
      if (!(error instanceof QueueConflict)) this.storageFailure(error);
    }
  }

  async deletePolygon(id: number): Promise<void> {
    if (
      !this.state.listLoaded ||
      !this.state.polygons.some((polygon) => polygon.id === id) ||
      !this.begin("delete", id)
    )
      return;

    try {
      await this.worker.exclusive(async () => {
        await this.readDeliveryView();
        if (!this.state.polygons.some((polygon) => polygon.id === id)) return;
        if (!(await this.api.delete(id))) {
          this.update({ deleteError: true });
          return;
        }
        await this.storage.writePolygons({ removedId: id });
        this.worker.announce();
        await this.readDeliveryView();
      });
    } catch {
      this.update({ deleteError: true });
    } finally {
      this.end();
    }
  }

  private update(patch: Partial<EditorSnapshot>): void {
    if (
      !Object.entries(patch).some(
        ([key, value]) => this.state[key as keyof EditorSnapshot] !== value,
      )
    )
      return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async readDeliveryView(
    patch: Partial<EditorSnapshot> = {},
  ): Promise<WorkspaceView> {
    const next = await this.storage.readView();
    if (!this.view || next.revision >= this.view.revision) {
      const newRevision = next.revision !== this.view?.revision;
      const workspace =
        this.view && this.view.workspace.revision > next.workspace.revision
          ? this.view.workspace
          : next.workspace;
      this.view = { ...next, workspace };
      const local = this.current;
      if (
        local &&
        workspace.revision > local.revision &&
        workspace.imageId === local.imageId &&
        workspace.draft === null &&
        this.state.draft === null &&
        !this.state.draftPending &&
        !this.state.enqueueing &&
        !this.state.restoring
      )
        this.current = workspace;
      if (newRevision) {
        const queue = retainQueue(this.state.queue, next.queue);
        const polygons = retainPolygons(
          this.state.polygons,
          mergePolygons(next.polygons ?? [], next.receipts),
        );
        patch = {
          queue,
          polygons,
          listFromCache:
            !this.state.listLoaded && Boolean(next.polygons?.length),
          ...(!this.state.image &&
          this.state.imageStatus === "missing" &&
          !this.state.draft &&
          !imageBound(queue)
            ? { imageStatus: "error" as const }
            : {}),
          ...patch,
        };
      }
    }
    this.update(patch);
    const view = this.view;
    this.worker.observe(view.queue);
    return view;
  }

  private async applyCommittedView(
    patch: Partial<EditorSnapshot>,
  ): Promise<void> {
    this.worker.announce();
    try {
      await this.readDeliveryView(patch);
    } catch {
      // The local transaction is committed. A failed reread must not resurrect
      // the editable draft or trigger another enqueue of the same shape.
      this.update(patch);
      this.worker.pause();
    }
  }

  private begin(
    operation: Operation,
    deletingId: number | null = null,
  ): boolean {
    if (this.state.operation !== null) return false;
    this.update({
      operation,
      deletingId,
      ...(operation === "delete" ? { deleteError: false } : {}),
    });
    return true;
  }

  private end(): void {
    this.update({ operation: null, deletingId: null });
  }

  private editable(phase: EditableDraft["phase"]): EditableDraft | null {
    const { draft } = this.state;
    return draft?.phase === phase && canEditDraft(this.state) ? draft : null;
  }

  private edit(draft: EditableDraft): void {
    // Queue the write before notifying subscribers, so an immediate Save also flushes this edit.
    const queued = this.writes.then(async () => {
      await this.persist(draft);
      if (this.writes === queued) this.update({ draftPending: false });
    });
    this.writes = queued;
    this.update({ draft, draftPending: true, saveStatus: "idle" });
  }

  private async persist(draft: EditableDraft | null): Promise<boolean> {
    if (this.state.stale || !this.current) return false;
    try {
      this.current = await this.storage.write(this.current, { draft });
      if (this.state.storageError) this.update({ storageError: false });
      return true;
    } catch (error) {
      this.storageFailure(error);
      return false;
    }
  }

  private storageFailure(error: unknown): void {
    if (error instanceof RevisionConflict)
      this.update({ stale: true, storageError: false });
    else this.update({ storageError: true });
  }

  private async adoptStoredWorkspace(): Promise<Workspace> {
    const current = await this.storage.read();
    this.current = current;
    this.update({
      imageId: current.imageId,
      draft: current.draft,
      stale: false,
      storageError: false,
      saveStatus: "idle",
    });
    return current;
  }

  private async cachedPicture(
    imageId: string | null,
  ): Promise<HTMLImageElement | null> {
    if (imageId === null) return null;
    const blob = await this.storage.readImage(imageId);
    if (blob === null) return null;
    try {
      return await decodePicture(blob);
    } catch {
      return null;
    }
  }

  private showImage(image: HTMLImageElement | null): void {
    this.update({
      image,
      imageStatus: image
        ? "ready"
        : this.state.draft || imageBound(this.state.queue)
          ? "missing"
          : "error",
    });
  }

  private async loadImage(mode: "start" | "retry" | "reload"): Promise<void> {
    if (
      this.imageLoading ||
      this.state.discarding ||
      this.state.enqueueing ||
      this.state.restoring
    )
      return;
    this.imageLoading = true;
    this.update({ image: null, imageStatus: "loading" });
    try {
      if (mode === "reload") await this.writes;
      const current =
        mode === "retry" && this.current
          ? this.current
          : await this.adoptStoredWorkspace();
      const image = await this.cachedPicture(current.imageId);
      if (!image) await this.readDeliveryView();
      if (
        !image &&
        current.draft === null &&
        !imageBound(this.state.queue) &&
        (current.imageId === null || mode === "retry")
      ) {
        await this.replacePicture(current);
      } else {
        this.showImage(image);
      }
    } catch (error) {
      this.storageFailure(error);
      this.showImage(null);
    } finally {
      this.imageLoading = false;
    }
  }

  private async replacePicture(expected: Workspace): Promise<void> {
    let blob: Blob;
    let image: HTMLImageElement;
    try {
      ({ blob, image } = await fetchPicture(this.fetchImage));
    } catch {
      this.showImage(null);
      return;
    }
    try {
      this.current = await this.storage.write(expected, {
        image: { id: randomId(), blob },
      });
      this.update({ storageError: false, imageId: this.current.imageId });
      this.showImage(image);
    } catch (error) {
      if (error instanceof RevisionConflict && expected.revision === 0) {
        const winner = await this.adoptStoredWorkspace();
        this.showImage(await this.cachedPicture(winner.imageId));
      } else {
        throw error;
      }
    }
  }
}
