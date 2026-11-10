import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { EditorSnapshot } from "./editor";
import { MAX_VERTICES, type Point } from "./geometry";
import type { QueueItem, QueueState } from "./saveQueue";
import "./styles.css";

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

afterEach(() => {
  host.style.width = "";
  flushSync(() => {
    root.render(null);
  });
});

const points = [
  [40, 40],
  [300, 70],
  [90, 250],
] as const;
const editable = { id: "draft-a", phase: "drawing", name: "", points } as const;
const saved = { id: 8, name: "Lane A", points };
const queueItem = (state: QueueState, name = "Lane A"): QueueItem => ({
  sequence: 1,
  revision: 1,
  imageId: "scene",
  submission: { key: "key", body: { name, points } },
  state,
});
const ready: EditorSnapshot = {
  image: null,
  imageStatus: "ready",
  listStatus: "ready",
  listLoaded: true,
  listFromCache: false,
  polygons: [],
  draft: null,
  operation: null,
  deletingId: null,
  stale: false,
  storageError: false,
  saveStatus: "idle",
  deleteError: false,
  draftPending: false,
  imageId: "scene",
  enqueueing: false,
  restoring: false,
  queueAvailable: true,
  queueError: false,
  lastSaved: null,
  queue: [],
  discarding: false,
};

function mount(initial: Partial<EditorSnapshot> = {}) {
  let state: EditorSnapshot = { ...ready, ...initial };
  const listeners = new Set<() => void>();
  const editor = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: vi.fn(async () => {}),
    newPolygon: vi.fn(),
    addPoint: vi.fn(),
    movePoint: vi.fn(),
    undo: vi.fn(),
    finish: vi.fn(),
    setName: vi.fn(),
    back: vi.fn(),
    cancel: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    retryQueue: vi.fn(async () => {}),
    discardQueued: vi.fn(async () => {}),
    restoreQueued: vi.fn(async () => {}),
    reloadWorkspace: vi.fn(async () => {}),
    retryImage: vi.fn(async () => {}),
    refreshList: vi.fn(async () => {}),
    deletePolygon: vi.fn(async () => {}),
  };
  flushSync(() => {
    root.render(<App editor={editor} />);
  });
  const update = (patch: Partial<EditorSnapshot>) => {
    state = { ...state, ...patch };
    flushSync(() => {
      listeners.forEach((listener) => {
        listener();
      });
    });
  };
  return { editor, update };
}

const button = (name: string) =>
  page.getByRole("button", { name, exact: true });

it("offers Save and the queue even before the API list is available", async () => {
  mount({
    listStatus: "error",
    listLoaded: false,
    draft: { ...editable, phase: "naming", name: "Offline lane" },
  });
  await expect.element(button("Save polygon")).toBeEnabled();
  await expect.element(button("Save queue")).toBeVisible();
});

it("keeps saved list controls and rows in place when requests settle", async () => {
  host.style.width = "320px";
  const polygons = Array.from({ length: 9 }, (_, index) => ({
    ...saved,
    id: index + 1,
    name: `Lane ${String(index + 1)}`,
  }));
  const { update } = mount({
    listStatus: "loading",
    listLoaded: false,
    operation: "list",
  });
  const refresh = host.querySelector('button[aria-label="Refresh list"]');
  if (!refresh) throw new Error("Expected a refresh control");
  const bounds = (element: Element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height];
  };
  const expectStable = (element: Element, original: number[]) => {
    bounds(element).forEach((value, index) => {
      expect(value).toBeCloseTo(original[index] ?? 0, 0);
    });
  };
  const refreshPosition = bounds(refresh);
  update({ polygons, listFromCache: true });
  const firstRow = host.querySelector("li");
  if (!firstRow) throw new Error("Expected a cached row");
  const rowPosition = bounds(firstRow);
  expectStable(refresh, refreshPosition);

  update({
    listStatus: "ready",
    listLoaded: true,
    listFromCache: false,
    operation: null,
  });
  expectStable(firstRow, rowPosition);
  expectStable(refresh, refreshPosition);

  update({ operation: "list" });
  await expect.element(button("Refresh list")).toBeDisabled();
  expectStable(firstRow, rowPosition);
  update({ listStatus: "error", operation: null });
  const retry = host.querySelector('button[aria-label="Retry list"]');
  if (!retry) throw new Error("Expected a retry control");
  expectStable(retry, refreshPosition);
  expectStable(firstRow, rowPosition);

  const remove = firstRow.querySelector(".danger");
  if (!remove) throw new Error("Expected a delete control");
  const removePosition = bounds(remove);
  update({ listStatus: "ready", operation: "delete", deletingId: 1 });
  expectStable(remove, removePosition);
  update({ operation: null, deletingId: null, polygons: polygons.slice(0, 8) });
  expectStable(refresh, refreshPosition);
  expectStable(firstRow, rowPosition);
});

it("focuses the restored name once the scene becomes editable", async () => {
  const { update } = mount({
    imageStatus: "loading",
    draft: { ...editable, phase: "naming", name: "Restored lane" },
  });
  const name = page.getByLabelText("Polygon name");
  await expect.element(name).toBeDisabled();
  update({ imageStatus: "ready" });
  await expect.element(name).toHaveFocus();
  await button("Refresh list").click();
  update({ draftPending: true });
  await expect.element(button("Refresh list")).toHaveFocus();
});

it("disables editing controls while the draft is being discarded", async () => {
  const { update } = mount({
    draft: { ...editable, phase: "naming", name: "Lane A" },
  });
  await expect.element(button("Save polygon")).toBeEnabled();
  update({ discarding: true });
  await expect.element(page.getByLabelText("Polygon name")).toBeDisabled();
  await expect.element(button("Save polygon")).toBeDisabled();
  await expect.element(button("Cancel")).toBeDisabled();
  update({ discarding: false, storageError: true });
  await expect.element(button("Cancel")).toBeEnabled();
});

it("exposes drawing, validation, naming, and save controls", async () => {
  const { editor, update } = mount({
    imageStatus: "loading",
    listStatus: "loading",
    listLoaded: false,
    operation: "list",
  });
  await expect
    .element(page.getByText("Loading the scene image…"))
    .toBeVisible();
  await expect.element(page.getByText("Loading polygons…")).toBeVisible();
  await expect.element(button("New polygon")).toBeDisabled();
  update({
    imageStatus: "ready",
    listStatus: "ready",
    listLoaded: true,
    operation: null,
  });
  await button("New polygon").click();
  expect(editor.newPolygon).toHaveBeenCalledOnce();
  update({ draft: { ...editable, points: [] } });
  await expect.element(button("Undo point")).toBeDisabled();
  update({ draft: { ...editable, points: [[0, 0]] } });
  await expect
    .element(page.getByText("1 vertex", { exact: true }))
    .toBeVisible();
  await button("Undo point").click();
  expect(editor.undo).toHaveBeenCalledOnce();
  const duplicatePoints: readonly Point[] = Array.from(
    { length: MAX_VERTICES },
    () => [0, 0],
  );
  update({ draft: { ...editable, points: duplicatePoints } });
  await expect
    .element(page.getByText("Vertex limit reached.", { exact: false }))
    .toBeVisible();
  await expect.element(button("Finish shape")).toBeDisabled();
  update({ draft: editable, draftPending: true });
  await expect
    .element(page.getByText("Saving draft in this browser…"))
    .toBeVisible();
  update({ draftPending: false });
  await expect
    .element(page.getByText("Draft saved in this browser."))
    .toBeVisible();
  await button("Finish shape").click();
  expect(editor.finish).toHaveBeenCalledOnce();
  await button("Cancel").click();
  expect(editor.cancel).toHaveBeenCalledOnce();

  update({ draft: { ...editable, phase: "naming" } });
  await expect.element(button("Save polygon")).toBeDisabled();
  await page.getByLabelText("Polygon name").fill("Lane A");
  expect(editor.setName).toHaveBeenLastCalledWith("Lane A");
  update({
    draft: { ...editable, phase: "naming", name: "Lane A" },
    listLoaded: false,
  });
  await expect.element(button("Save polygon")).toBeEnabled();
  await button("Save polygon").click();
  expect(editor.save).toHaveBeenCalledOnce();
  await button("Back to drawing").click();
  expect(editor.back).toHaveBeenCalledOnce();
  update({ enqueueing: true });
  await expect.element(button("Queueing…")).toBeDisabled();
  expect(editor.start).toHaveBeenCalledOnce();
});

it("surfaces independently failed resources and supports submission recovery", async () => {
  const { editor, update } = mount({
    queue: [queueItem({ status: "paused" })],
    imageStatus: "missing",
    listStatus: "error",
    listLoaded: false,
  });
  await expect
    .element(
      page.getByText("The original scene image is unavailable.", {
        exact: false,
      }),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("The polygon list could not be loaded."))
    .toBeVisible();
  await button("Retry image").click();
  expect(editor.retryImage).toHaveBeenCalledOnce();
  await button("Save queue").click();
  await button("Retry queue").click();
  expect(editor.retryQueue).toHaveBeenCalledOnce();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    await button("Discard request").click();
    expect(editor.discardQueued).toHaveBeenCalledWith(1);
  } finally {
    confirm.mockRestore();
  }
  await button("Retry list").click();
  expect(editor.refreshList).toHaveBeenCalledOnce();

  update({
    stale: true,
    storageError: true,
    queue: [queueItem({ status: "failed", reason: "conflict" })],
    imageStatus: "error",
  });
  await expect
    .element(page.getByText("Browser storage failed.", { exact: false }))
    .toBeVisible();
  await expect.element(button("Retry queue")).not.toBeInTheDocument();
  await expect.element(button("Retry image")).toBeDisabled();
  await button("Reload workspace").click();
  expect(editor.reloadWorkspace).toHaveBeenCalledOnce();
  update({
    stale: false,
    storageError: false,
    listLoaded: true,
    polygons: [saved],
    operation: "delete",
    deletingId: 8,
  });
  await expect
    .element(page.getByText("Refresh failed.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("Deleting…")).toBeVisible();
  await expect.element(button("Delete Lane A")).toBeDisabled();
  update({ operation: null, deletingId: null, deleteError: true });
  await expect
    .element(
      page.getByText("The polygon could not be deleted.", { exact: false }),
    )
    .toBeVisible();
  await button("Delete Lane A").click();
  expect(editor.deletePolygon).toHaveBeenCalledWith(8);
});

it("keeps a long pending name within the narrow editor", async () => {
  host.style.width = "320px";
  const name = "W".repeat(100);
  mount({ queue: [queueItem({ status: "paused" }, name)] });
  await button("Save queue").click();
  await expect.element(page.getByText(name, { exact: true })).toBeVisible();
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
});

it("returns focus to the queue summary after a focused failed item is discarded", async () => {
  const { editor, update } = mount({
    queue: [queueItem({ status: "failed", reason: "invalid" })],
  });
  const summary = button("Save queue");
  await summary.click();
  const discard = button("Discard request");
  await discard.click();
  expect(editor.discardQueued).toHaveBeenCalledWith(1);
  await expect.element(discard).toHaveFocus();
  update({ queue: [] });
  await expect.element(summary).toHaveFocus();
});

it("promotes the sending outline to one saved contour", async () => {
  const image = new Image(1920, 1080);
  image.src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'><rect width='1920' height='1080' fill='blue'/></svg>";
  await image.decode();
  const outline = [
    [480, 270],
    [1440, 270],
    [960, 810],
  ] as const;
  const polygon = { ...saved, points: outline };
  const item = {
    ...queueItem({ status: "sending", attempts: 1 }),
    submission: { key: "key", body: { name: saved.name, points: outline } },
  };
  const { update } = mount({ image, queue: [item] });
  const sample = document.createElement("canvas");
  sample.width = 1;
  sample.height = 1;
  const context = sample.getContext("2d");
  if (!context) throw new Error("Expected a 2D canvas context");
  const outlinePixel = () => {
    const layers = host.querySelectorAll("canvas");
    if (!layers.length) return [];
    context.clearRect(0, 0, 1, 1);
    for (const layer of layers) {
      context.drawImage(
        layer,
        Math.floor(layer.width / 2),
        Math.floor(layer.height / 4),
        1,
        1,
        0,
        0,
        1,
        1,
      );
    }
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const canvas = page.getByRole("img", { name: "Polygon drawing canvas" });
  await expect.poll(() => outlinePixel().slice(0, 3)).toEqual([185, 161, 255]);
  update({
    queue: [],
    polygons: [polygon],
    lastSaved: { sequence: 1, name: polygon.name },
  });
  const firstFrame = await new Promise<number[]>((resolve) => {
    requestAnimationFrame(() => {
      resolve(outlinePixel().slice(0, 3));
    });
  });
  expect(firstFrame).toEqual([102, 255, 224]);
  await expect
    .element(canvas)
    .toHaveAttribute("aria-description", "1 saved polygons");
  await expect.poll(() => outlinePixel().slice(0, 3)).toEqual([102, 255, 224]);
  expect(host.querySelectorAll(".canvas-surface canvas")).toHaveLength(2);
  await expect
    .element(page.getByText("Saved Lane A", { exact: true }))
    .toBeInTheDocument();
});

it("places the start action in the scene and pages through saved polygons", async () => {
  const polygons = Array.from({ length: 9 }, (_, index) => ({
    ...saved,
    id: index + 1,
    name: `Lane ${String(index + 1)}`,
  }));
  const { editor, update } = mount({ polygons });
  const scene = page.getByRole("region", { name: "Scene" });
  await expect
    .element(scene.getByRole("button", { name: "New polygon" }))
    .toBeVisible();
  await expect
    .element(
      scene.getByText("Click or tap empty space to start.", { exact: false }),
    )
    .toBeVisible();
  await expect.element(page.getByText("1–8 of 9")).toBeVisible();
  await expect.element(button("Previous page")).toBeDisabled();
  await button("Next page").click();
  await expect.element(page.getByText("9–9 of 9")).toBeVisible();
  await expect.element(button("Next page")).toBeDisabled();
  await button("Previous page").click();
  await expect.element(page.getByText("1–8 of 9")).toBeVisible();

  await button("Lane 1").click();
  await expect
    .element(button("Lane 1"))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(scene.getByText("Selected: Lane 1")).toBeVisible();
  const canvas = scene.getByRole("img", { name: "Polygon drawing canvas" });
  function key(target: Element, value: string) {
    flushSync(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }
  key(canvas.element(), "Delete");
  expect(editor.deletePolygon).toHaveBeenCalledWith(1);
  key(canvas.element(), "Escape");
  await expect
    .element(scene.getByText("Selected: Lane 1"))
    .not.toBeInTheDocument();
  key(canvas.element(), "Delete");
  expect(editor.deletePolygon).toHaveBeenCalledOnce();
  await button("Next page").click();
  await button("Lane 9").click();
  key(button("Lane 9").element(), "Backspace");
  expect(editor.deletePolygon).toHaveBeenLastCalledWith(9);
  update({ polygons: polygons.slice(0, 8) });
  await expect.element(button("Lane 1")).toBeVisible();
  await expect.element(button("Next page")).not.toBeInTheDocument();
  update({ polygons });
  await expect.element(page.getByText("1–8 of 9")).toBeVisible();
  await expect
    .element(scene.getByText("Selected: Lane 9"))
    .not.toBeInTheDocument();
});

it("focuses the inline name and disables save on a visually flat contour", async () => {
  const draft = { ...editable, name: "Lane A", phase: "naming" } as const;
  const { update } = mount({
    draft: {
      ...draft,
      points: [
        [10, 50],
        [200, 50.25],
        [400, 50],
      ],
    },
  });
  const scene = page.getByRole("region", { name: "Scene" });
  await expect.element(scene.getByLabelText("Polygon name")).toHaveFocus();
  await expect
    .element(scene.getByRole("button", { name: "Save polygon" }))
    .toBeDisabled();
  await expect
    .element(
      scene.getByText(
        "The shape needs visible area and edges that do not cross.",
      ),
    )
    .toBeVisible();
  update({ draft });
  await expect
    .element(scene.getByRole("button", { name: "Save polygon" }))
    .toBeEnabled();
});
