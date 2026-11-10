import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Editor, EditorSnapshot } from "./editor";
import { queueStyles } from "./polygonStatus";

const failureMessages = {
  invalid: "The server rejected this polygon.",
  deleted: "The earlier save was deleted.",
  conflict: "The save key belongs to a different request.",
};

export function SaveQueuePanel({
  state,
  editor,
  children,
}: {
  state: Pick<
    EditorSnapshot,
    | "queue"
    | "queueError"
    | "queueAvailable"
    | "draft"
    | "imageId"
    | "imageStatus"
    | "lastSaved"
  >;
  editor: Pick<Editor, "retryQueue" | "discardQueued" | "restoreQueued">;
  children: ReactNode;
}) {
  const { queue, queueError, queueAvailable } = state;
  const [expanded, setExpanded] = useState(false);
  const summary = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLElement>(null);
  const focusWasInDetails = useRef(false);
  const detailsId = useId();
  const head = queue.find(({ state }) => state.status !== "failed");
  const failed = queue.some(({ state }) => state.status === "failed");
  const canRetry =
    queueAvailable && (queueError || head?.state.status === "paused");
  const status = !queueAvailable
    ? "Unavailable"
    : queueError
      ? "Storage error"
      : head
        ? queueStyles[head.state.status].label
        : failed
          ? "Needs attention"
          : "Empty";

  useLayoutEffect(() => {
    if (focusWasInDetails.current && document.activeElement === document.body) {
      focusWasInDetails.current = false;
      summary.current?.focus({ preventScroll: true });
    }
  }, [queue, canRetry, expanded]);

  return (
    <>
      <div className="queue-summary">
        <button
          ref={summary}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          Save queue
        </button>
        <p
          className={`queue-summary-status ${queueError ? "error" : "help"}`}
          role="status"
        >
          {queue.length} · {status}
        </p>
        <span className="sr-only" role="status">
          {state.lastSaved && (
            <span key={state.lastSaved.sequence}>
              Saved {state.lastSaved.name}
            </span>
          )}
        </span>
      </div>
      {children}
      <section
        ref={details}
        id={detailsId}
        className="queue-details"
        aria-label="Save queue details"
        hidden={!expanded}
        onFocusCapture={() => {
          focusWasInDetails.current = true;
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget &&
            !details.current?.contains(event.relatedTarget)
          ) {
            focusWasInDetails.current = false;
          }
        }}
      >
        {!queueAvailable && (
          <p className="error">
            Open the editor on localhost in a browser with Web Locks support to
            save.
          </p>
        )}
        {queueError && (
          <p className="error" role="alert">
            Queue storage failed. Retry to resume saving.
          </p>
        )}
        {canRetry && (
          <button onClick={() => void editor.retryQueue()}>Retry queue</button>
        )}
        {queue.length === 0 && <p className="help">No pending saves.</p>}
        {queue.length > 0 && (
          <ul className="queue-items" aria-label="Queued polygons">
            {queue.map((item) => {
              const { state: delivery } = item;
              const style = queueStyles[delivery.status];
              const canRestore =
                delivery.status === "failed" &&
                delivery.reason !== "conflict" &&
                state.draft === null &&
                state.imageStatus === "ready" &&
                state.imageId === item.imageId;
              return (
                <li key={item.sequence} data-save-status={delivery.status}>
                  <div className="queue-item-heading">
                    <span
                      className="queue-swatch"
                      style={{ backgroundColor: style.stroke }}
                      aria-hidden="true"
                    />
                    <span
                      className="queue-item-name"
                      title={item.submission.body.name}
                    >
                      {item.submission.body.name}
                    </span>
                    <span className="help">{style.label}</span>
                  </div>
                  {delivery.status === "failed" && (
                    <p className="help">{failureMessages[delivery.reason]}</p>
                  )}
                  {(delivery.status === "failed" ||
                    delivery.status === "paused") && (
                    <div className="actions">
                      {canRestore && (
                        <button
                          onClick={() =>
                            void editor.restoreQueued(item.sequence)
                          }
                        >
                          Restore as draft
                        </button>
                      )}
                      <button
                        className="danger"
                        onClick={() => {
                          if (
                            delivery.status === "failed" ||
                            window.confirm(
                              "The server may already have saved this polygon. Discard the local request?",
                            )
                          )
                            void editor.discardQueued(item.sequence);
                        }}
                      >
                        Discard request
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
