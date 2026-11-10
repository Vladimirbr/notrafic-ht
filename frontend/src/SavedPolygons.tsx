import type { Editor, EditorSnapshot } from "./editor";
import { SaveQueuePanel } from "./SaveQueuePanel";
import { isDeleteKey, isPlainShortcut } from "./shortcuts";

export const PAGE_SIZE = 8;

export function SavedPolygons({
  state,
  editor,
  selectedId,
  page,
  lastPage,
  onSelect,
  onPageChange,
}: {
  state: Pick<
    EditorSnapshot,
    | "draft"
    | "listStatus"
    | "listLoaded"
    | "listFromCache"
    | "polygons"
    | "operation"
    | "deletingId"
    | "deleteError"
    | "queue"
    | "queueError"
    | "queueAvailable"
    | "imageId"
    | "imageStatus"
    | "lastSaved"
  >;
  editor: Pick<
    Editor,
    | "deletePolygon"
    | "refreshList"
    | "retryQueue"
    | "discardQueued"
    | "restoreQueued"
  >;
  selectedId: number | undefined;
  page: number;
  lastPage: number;
  onSelect: (id: number) => void;
  onPageChange: (page: number) => void;
}) {
  const {
    listStatus,
    listLoaded,
    listFromCache,
    polygons,
    operation,
    deletingId,
    deleteError,
  } = state;
  const canDelete = listLoaded && operation === null;
  const loading = listStatus === "loading" || operation === "list";
  const showError = !loading && (deleteError || listStatus === "error");
  const start = page * PAGE_SIZE;
  const visible = polygons.slice(start, start + PAGE_SIZE);
  const refreshLabel = listStatus === "error" ? "Retry" : "Refresh";

  let feedback: string;
  if (loading) {
    feedback = listFromCache
      ? "Checking for updates. Showing the local copy."
      : listLoaded
        ? "Refreshing polygons…"
        : "Loading polygons…";
  } else if (deleteError) {
    feedback = "The polygon could not be deleted. Try again.";
  } else if (listStatus === "error") {
    feedback = listFromCache
      ? "Refresh failed. Showing the local copy."
      : listLoaded
        ? "Refresh failed. Showing the last confirmed polygons."
        : "The polygon list could not be loaded.";
  } else {
    feedback = polygons.length
      ? `${String(start + 1)}–${String(start + visible.length)} of ${String(polygons.length)}`
      : "No saved polygons yet.";
  }

  return (
    <section className="panel" aria-labelledby="saved-title">
      <h2 id="saved-title">Saved polygons</h2>
      <nav
        className="pagination-actions"
        aria-label="Saved polygon list controls"
      >
        {lastPage > 0 && (
          <>
            <button
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => {
                onPageChange(page - 1);
              }}
            >
              Prev
            </button>
            <button
              aria-label="Next page"
              disabled={page === lastPage}
              onClick={() => {
                onPageChange(page + 1);
              }}
            >
              Next
            </button>
          </>
        )}
        <button
          className="list-refresh"
          aria-label={`${refreshLabel} list`}
          disabled={operation !== null}
          onClick={() => void editor.refreshList()}
        >
          {refreshLabel}
        </button>
      </nav>
      <SaveQueuePanel state={state} editor={editor}>
        <div className="list-feedback">
          <p className="help" role="status">
            {showError ? null : feedback}
          </p>
          <p className="error" role="alert">
            {showError ? feedback : null}
          </p>
        </div>
        {polygons.length > 0 && (
          <ul className="list" role="list" aria-label="Saved polygon list">
            {visible.map(({ id, name }) => (
              <li key={id} data-polygon-id={id}>
                <button
                  className="polygon-name"
                  title={name}
                  disabled={state.draft !== null}
                  aria-pressed={selectedId === id}
                  onClick={() => {
                    onSelect(id);
                  }}
                  onKeyDown={(event) => {
                    if (
                      selectedId === id &&
                      canDelete &&
                      isPlainShortcut(event) &&
                      isDeleteKey(event.key)
                    ) {
                      event.preventDefault();
                      void editor.deletePolygon(id);
                    }
                  }}
                >
                  {name}
                </button>
                <button
                  className="danger list-delete"
                  aria-label={`Delete ${name}`}
                  disabled={!canDelete}
                  onClick={() => void editor.deletePolygon(id)}
                >
                  {deletingId === id ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SaveQueuePanel>
    </section>
  );
}
