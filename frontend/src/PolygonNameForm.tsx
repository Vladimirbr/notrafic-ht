import { useId } from "react";
import type { Editor } from "./editor";
import { MAX_NAME_LENGTH, normalizeName } from "./geometry";

function focusName(input: HTMLInputElement | null) {
  if (!input || input.disabled) return;
  input.focus({ preventScroll: true });
  const { top, bottom } = input.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visibleTop = viewport?.offsetTop ?? 0;
  const visibleHeight = viewport?.height ?? window.innerHeight;
  if (top < visibleTop || bottom > visibleTop + visibleHeight) {
    input.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
}

export function PolygonNameForm({
  name,
  imageReady,
  saving,
  editable,
  saveAvailable,
  cancelAvailable,
  shapeNeedsAdjustment,
  editor,
}: {
  name: string;
  imageReady: boolean;
  saving: boolean;
  editable: boolean;
  saveAvailable: boolean;
  cancelAvailable: boolean;
  shapeNeedsAdjustment: boolean;
  editor: Pick<Editor, "save" | "setName" | "back" | "cancel">;
}) {
  const nameId = useId();
  const helpId = `${nameId}-help`;
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void editor.save();
      }}
    >
      <div className="form-name">
        <label htmlFor={nameId}>Polygon name</label>
        <div className="name-row">
          <input
            id={nameId}
            ref={imageReady ? focusName : undefined}
            value={name}
            onChange={(event) => {
              editor.setName(event.target.value);
            }}
            aria-describedby={helpId}
            readOnly={saving}
            disabled={!saving && !editable}
          />
          <button
            className="primary"
            type="submit"
            disabled={!saveAvailable || normalizeName(name) === null}
          >
            {saving ? "Queueing…" : "Save polygon"}
          </button>
        </div>
      </div>
      <div className="actions form-secondary">
        <button
          type="button"
          disabled={!editable}
          onClick={() => {
            editor.back();
          }}
        >
          Back to drawing
        </button>
        <button
          type="button"
          disabled={!cancelAvailable}
          onClick={() => void editor.cancel()}
        >
          Cancel
        </button>
      </div>
      <p id={helpId} className="help name-help">
        {!shapeNeedsAdjustment
          ? `1–${String(MAX_NAME_LENGTH)} characters · Enter to save`
          : "The shape needs visible area and edges that do not cross."}
      </p>
    </form>
  );
}
