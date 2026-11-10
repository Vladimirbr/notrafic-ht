import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { PolygonCanvas } from "./Canvas";
import { DraftControls } from "./DraftControls";
import { PAGE_SIZE, SavedPolygons } from "./SavedPolygons";
import { canEditDraft, type Editor, type EditorSnapshot } from "./editor";
import { isDeleteKey, isPlainShortcut } from "./shortcuts";
import {
  containsPoint,
  MAX_VERTICES,
  IMAGE_WIDTH,
  IMAGE_HEIGHT,
  MIN_VERTICES,
  validDraftContour,
  type Point,
} from "./geometry";

type EditorView = Pick<
  Editor,
  | "getSnapshot"
  | "subscribe"
  | "start"
  | "newPolygon"
  | "addPoint"
  | "movePoint"
  | "undo"
  | "finish"
  | "setName"
  | "back"
  | "cancel"
  | "save"
  | "retryQueue"
  | "discardQueued"
  | "restoreQueued"
  | "reloadWorkspace"
  | "retryImage"
  | "refreshList"
  | "deletePolygon"
>;

const imageMessages: Record<
  Exclude<EditorSnapshot["imageStatus"], "ready">,
  string
> = {
  loading: "Loading the scene image…",
  error: "The scene image could not be loaded.",
  missing:
    "The original scene image is unavailable. Resolve local polygons to load a new image.",
};

export function App({ editor }: { editor: EditorView }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [listPage, setListPage] = useState(0);
  useEffect(() => {
    void editor.start();
  }, [editor]);
  const { image, imageStatus, polygons, draft, stale, operation } = state;
  const lastPage = Math.max(0, Math.ceil(polygons.length / PAGE_SIZE) - 1);
  const page = Math.min(listPage, lastPage);
  if (listPage !== page) setListPage(page);
  const selectedPolygon = polygons.find(({ id }) => id === selectedId);
  if (selectedId !== null && !selectedPolygon) setSelectedId(null);
  const unsavedDraft =
    state.draftPending || ((state.storageError || stale) && draft !== null);
  useEffect(() => {
    if (!unsavedDraft) return;
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventDiscard);
    return () => {
      window.removeEventListener("beforeunload", preventDiscard);
    };
  }, [unsavedDraft]);
  const editing = canEditDraft(state);
  const drawing = editing && draft?.phase === "drawing";
  const idle = editing && draft === null;
  const selected = draft === null ? selectedPolygon : undefined;
  const canDelete =
    selected !== undefined && state.listLoaded && operation === null;
  const contourPoints = draft?.points;
  const visibleQueue = useMemo(
    () => state.queue.filter((item) => item.imageId === state.imageId),
    [state.queue, state.imageId],
  );
  const contourValid = useMemo(
    () => contourPoints !== undefined && validDraftContour(contourPoints),
    [contourPoints],
  );

  function startPolygon(point?: Point) {
    setSelectedId(null);
    editor.newPolygon(point);
  }

  function selectPolygon(id: number) {
    setSelectedId(id);
    const index = polygons.findIndex((polygon) => polygon.id === id);
    setListPage(Math.floor(Math.max(0, index) / PAGE_SIZE));
  }

  function sceneTap(point: Point) {
    if (drawing) {
      editor.addPoint(point);
    } else if (idle) {
      const hit = polygons.findLast((polygon) =>
        containsPoint(polygon.points, point),
      );
      if (hit) selectPolygon(hit.id);
      else startPolygon(point);
    }
  }

  function sceneKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!isPlainShortcut(event)) return;
    if (event.key === "Enter" && drawing && contourValid) {
      event.preventDefault();
      editor.finish();
    } else if (event.key === "Escape" && selected) {
      setSelectedId(null);
    } else if (isDeleteKey(event.key) && selected && canDelete) {
      event.preventDefault();
      void editor.deletePolygon(selected.id);
    }
  }

  let sceneMessage: string;
  if (imageStatus !== "ready") sceneMessage = imageMessages[imageStatus];
  else if (stale) sceneMessage = "Reload the workspace to continue editing.";
  else if (state.discarding) sceneMessage = "Discarding draft…";
  else if (draft?.phase === "drawing") {
    if (draft.points.length === MAX_VERTICES)
      sceneMessage = "Vertex limit reached. Finish the shape or undo a point.";
    else if (contourValid)
      sceneMessage =
        "Close with the first vertex, double-click or Enter. Drag vertices to adjust.";
    else if (draft.points.length >= MIN_VERTICES)
      sceneMessage =
        "The shape needs visible area and edges that do not cross.";
    else
      sceneMessage =
        "Click or tap the image to add a vertex. Drag vertices to adjust.";
  } else sceneMessage = "Click or tap empty space to start.";
  const imageFailed = imageStatus === "error" || imageStatus === "missing";

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <span className="brand">NoTraffic</span>
          <h1>Polygon Editor</h1>
        </div>
      </header>
      <main className="layout">
        <section className="scene" aria-labelledby="scene-title">
          <div className="scene-header">
            <h2 id="scene-title">Scene</h2>
            <p className="scene-meta">
              {IMAGE_WIDTH} × {IMAGE_HEIGHT} source pixels
            </p>
          </div>
          <PolygonCanvas
            image={image}
            polygons={polygons}
            draft={draft}
            draftId={draft?.id}
            queue={visibleQueue}
            deletingId={state.deletingId}
            drawing={drawing}
            idle={idle}
            selectedId={selected?.id}
            onSceneKey={sceneKey}
            onClose={
              drawing
                ? () => {
                    editor.finish();
                  }
                : undefined
            }
            canCloseFirst={contourValid}
            onMovePoint={
              editing && draft !== null
                ? (index, point) => {
                    editor.movePoint(index, point);
                  }
                : undefined
            }
            onPoint={sceneTap}
          />
          <DraftControls
            state={state}
            editor={editor}
            contourValid={contourValid}
            editable={editing}
            sceneMessage={sceneMessage}
            onNewPolygon={() => {
              startPolygon();
            }}
          >
            {imageFailed && (
              <div className="actions">
                <button
                  disabled={stale || state.discarding || operation !== null}
                  onClick={() => void editor.retryImage()}
                >
                  Retry image
                </button>
              </div>
            )}
            {selected && (
              <div className="selection-bar">
                <p className="status" role="status">
                  Selected: {selected.name}
                </p>
                <button
                  className="danger"
                  disabled={!canDelete}
                  onClick={() => void editor.deletePolygon(selected.id)}
                >
                  Delete selected polygon
                </button>
              </div>
            )}
          </DraftControls>
        </section>
        <SavedPolygons
          state={state}
          editor={editor}
          selectedId={selected?.id}
          page={page}
          lastPage={lastPage}
          onSelect={selectPolygon}
          onPageChange={setListPage}
        />
      </main>
    </>
  );
}
