import type { Submission } from "./api";

type FailureReason = "invalid" | "deleted" | "conflict";

type Sending = { readonly status: "sending"; readonly attempts: number };

export type QueueState =
  | { readonly status: "queued" }
  | Sending
  | {
      readonly status: "retrying";
      readonly attempts: number;
      readonly retryAt: number;
    }
  | { readonly status: "paused" }
  | { readonly status: "failed"; readonly reason: FailureReason };

export type QueueItem = Readonly<{
  sequence: number;
  revision: number;
  imageId: string | null;
  submission: Submission;
  state: QueueState;
}>;

const RETRY_DELAYS = [2000, 5000, 15000];

export function queueHead(queue: readonly QueueItem[]): QueueItem | undefined {
  return queue.find(({ state }) => state.status !== "failed");
}

export function sameQueueVersion(
  expected: QueueItem,
  actual: QueueItem | undefined,
): boolean {
  return (
    actual?.sequence === expected.sequence &&
    actual.revision === expected.revision &&
    actual.submission.key === expected.submission.key
  );
}

export function nextAttempt(
  state: QueueState,
  now: number,
): Sending | { readonly status: "paused" } | null {
  switch (state.status) {
    case "queued":
      return { status: "sending", attempts: 1 };
    case "retrying":
      if (state.retryAt > now) return null;
      return { status: "sending", attempts: state.attempts + 1 };
    case "sending":
      return state.attempts <= RETRY_DELAYS.length
        ? { status: "sending", attempts: state.attempts + 1 }
        : { status: "paused" };
    default:
      return null;
  }
}

export function unsavedOutcome(
  attempts: number,
  result: FailureReason | "unknown",
  now: number,
): QueueState {
  if (result !== "unknown") return { status: "failed", reason: result };
  const delay = RETRY_DELAYS[attempts - 1];
  return delay === undefined
    ? { status: "paused" }
    : { status: "retrying", attempts, retryAt: now + delay };
}
