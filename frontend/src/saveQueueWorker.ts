import type { PolygonApi, SaveResult } from "./api";
import {
  nextAttempt,
  queueHead,
  sameQueueVersion,
  unsavedOutcome,
  type QueueItem,
} from "./saveQueue";
import type { WorkspaceStore, WorkspaceView } from "./workspace";

type PendingOutcome = {
  item: QueueItem;
  attempts: number;
  result: SaveResult;
  finishedAt: number;
};

export type SavedQueueNotice = Readonly<{ sequence: number; name: string }>;

type WorkerOptions = {
  storage: WorkspaceStore;
  api: Pick<PolygonApi, "save">;
  readView: (saved?: SavedQueueNotice) => Promise<WorkspaceView>;
  onError: (paused: boolean) => void;
};

const online = () => navigator.onLine;

export class SaveQueueWorker {
  private readonly locks: LockManager | undefined;
  private readonly name: string;
  private channel: BroadcastChannel | null = null;
  private head: QueueItem | undefined;
  private working = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: PendingOutcome | null = null;

  constructor(private readonly options: WorkerOptions) {
    const { locks } = navigator as Partial<Navigator>;
    this.locks = typeof locks?.request === "function" ? locks : undefined;
    this.name = `notraffic:polygon-delivery:${options.storage.coordinationKey}`;
  }

  get available(): boolean {
    return this.locks !== undefined;
  }

  start(): Promise<void> {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(this.name);
      this.channel.addEventListener("message", this.signal);
    }
    window.addEventListener("focus", this.signal);
    window.addEventListener("online", this.signal);
    window.addEventListener("offline", this.signal);
    return this.sync();
  }

  announce(): void {
    this.channel?.postMessage(null);
  }

  exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.locks ? this.locks.request(this.name, action) : action();
  }

  observe(queue: readonly QueueItem[]): void {
    this.head = queueHead(queue);
    this.schedule();
  }

  async retry(): Promise<void> {
    const expected = this.head;
    if (
      !this.available ||
      (!this.paused && expected?.state.status !== "paused")
    )
      return;
    try {
      await this.exclusive(async () => {
        const current = queueHead((await this.options.readView()).queue);
        const pending = this.pending;
        if (pending && sameQueueVersion(pending.item, current)) {
          await this.settle(pending);
        } else {
          this.pending = null;
          if (
            expected?.state.status === "paused" &&
            sameQueueVersion(expected, current)
          ) {
            await this.options.storage.updateQueue(expected, {
              status: "queued",
            });
            await this.publish();
          }
        }
        this.paused = false;
        this.options.onError(false);
        this.schedule();
      });
    } catch {
      this.pause();
    }
  }

  pause(): void {
    this.paused = true;
    clearTimeout(this.timer);
    this.options.onError(true);
  }

  private signal = (): void => {
    void this.sync();
  };

  private async sync(): Promise<void> {
    try {
      await this.options.readView();
    } catch {
      this.pause();
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const head = this.head;
    if (
      !this.available ||
      this.working ||
      this.paused ||
      !online() ||
      !head ||
      head.state.status === "paused"
    ) {
      return;
    }
    if (head.state.status === "retrying") {
      const delay = head.state.retryAt - Date.now();
      if (delay > 0) {
        this.timer = setTimeout(() => {
          this.schedule();
        }, delay);
        return;
      }
    }
    // Keep one acquisition pending even when another tab currently holds the
    // lock. A closing tab cannot broadcast, but its successor gets the lock.
    this.working = true;
    void this.exclusive(() => this.deliver())
      .catch(() => {
        this.pause();
      })
      .finally(() => {
        this.working = false;
        this.schedule();
      });
  }

  private async deliver(): Promise<void> {
    const head = queueHead((await this.options.readView()).queue);
    if (!head || !online() || this.paused) return;
    const state = nextAttempt(head.state, Date.now());
    if (!state) return;

    const attempt = await this.options.storage.updateQueue(head, state);
    await this.publish();
    if (state.status !== "sending") return;
    if (!online()) {
      await this.options.storage.updateQueue(attempt, head.state);
      await this.publish();
      return;
    }
    const result = await this.options.api
      .save(attempt.submission)
      .catch((): SaveResult => ({ kind: "unknown" }));
    this.pending = {
      item: attempt,
      attempts: state.attempts,
      result,
      finishedAt: Date.now(),
    };
    await this.settle(this.pending);
  }

  private async settle(outcome: PendingOutcome): Promise<void> {
    const { item, result, attempts, finishedAt } = outcome;
    if (result.kind === "saved") {
      await this.options.storage.acknowledgeQueue(item, result.polygon);
    } else {
      await this.options.storage.updateQueue(
        item,
        unsavedOutcome(attempts, result.kind, finishedAt),
      );
    }
    this.pending = null;
    await this.publish(
      result.kind === "saved"
        ? { sequence: item.sequence, name: result.polygon.name }
        : undefined,
    );
  }

  private async publish(saved?: SavedQueueNotice): Promise<void> {
    this.announce();
    await this.options.readView(saved);
  }
}
