import type { ReactNode } from "react";
import type { Editor, EditorSnapshot } from "./editor";
import { PolygonNameForm } from "./PolygonNameForm";

export function DraftControls({
  state,
  editor,
  contourValid,
  editable,
  sceneMessage,
  onNewPolygon,
  children,
}: {
  state: Pick<
    EditorSnapshot,
    | "draft"
    | "draftPending"
    | "discarding"
    | "imageStatus"
    | "enqueueing"
    | "queueAvailable"
    | "stale"
    | "storageError"
    | "saveStatus"
  >;
  editor: Pick<
    Editor,
    | "finish"
    | "undo"
    | "cancel"
    | "save"
    | "setName"
    | "back"
    | "reloadWorkspace"
  >;
  contourValid: boolean;
  editable: boolean;
  sceneMessage: string;
  onNewPolygon: () => void;
  children: ReactNode;
}) {
  const { draft, enqueueing, stale, storageError, saveStatus, queueAvailable } =
    state;
  const busy = enqueueing || state.discarding;
  const count = draft?.points.length ?? 0;

  return (
    <div className="scene-controls">
      {draft === null ? (
        <div className="actions scene-start">
          <button
            className="primary"
            disabled={!editable}
            onClick={onNewPolygon}
          >
            New polygon
          </button>
          <p className="help" role="status">
            {sceneMessage}
          </p>
        </div>
      ) : (
        <>
          {draft.phase === "drawing" && (
            <div className="actions">
              <button
                className="primary"
                disabled={!editable || !contourValid}
                onClick={() => {
                  editor.finish();
                }}
              >
                Finish shape
              </button>
              <button
                disabled={!editable || count === 0}
                onClick={() => {
                  editor.undo();
                }}
              >
                Undo point
              </button>
              <button
                disabled={busy || stale}
                onClick={() => void editor.cancel()}
              >
                Cancel
              </button>
            </div>
          )}
          {draft.phase === "naming" && (
            <PolygonNameForm
              name={draft.name}
              imageReady={state.imageStatus === "ready"}
              saving={enqueueing}
              editable={editable}
              saveAvailable={
                editable && !busy && queueAvailable && contourValid
              }
              cancelAvailable={!busy && !stale}
              shapeNeedsAdjustment={!contourValid}
              editor={editor}
            />
          )}
          <div className="scene-guide">
            {draft.phase === "drawing" && (
              <p className="help" role="status">
                {sceneMessage}
              </p>
            )}
            <p className="status" role="status">
              {count} {count === 1 ? "vertex" : "vertices"}
            </p>
          </div>
        </>
      )}
      {draft !== null && !storageError && !stale && (
        <p className="help" role="status">
          {state.draftPending
            ? "Saving draft in this browser…"
            : "Draft saved in this browser."}
        </p>
      )}
      {saveStatus === "invalid" && (
        <p className="error" role="alert">
          Review the name and shape before saving.
        </p>
      )}
      {!queueAvailable && draft?.phase === "naming" && (
        <p className="error" role="alert">
          Open the editor on localhost in a browser with Web Locks support to
          save.
        </p>
      )}
      {storageError && (
        <p className="error" role="alert">
          Browser storage failed. Your local edits are still in this tab. Try
          the action again.
        </p>
      )}
      {stale && (
        <div className="feedback">
          <p className="error" role="alert">
            Another tab changed this workspace. Reloading the workspace will
            replace edits in this tab.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => void editor.reloadWorkspace()}
            >
              Reload workspace
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
