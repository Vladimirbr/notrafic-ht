type PointerStart = {
  id: number;
  x: number;
  y: number;
  primary: boolean;
  button: number;
};

export const POINTER_SLOP_PX = 8;
const DOUBLE_CLICK_INTERVAL_MS = 400;
const DOUBLE_CLICK_DISTANCE_PX = 4;

type MouseRelease = {
  draftId: string;
  x: number;
  y: number;
  timeStamp: number;
};

export class MouseReleasePair {
  private previous: MouseRelease | undefined;

  accept(release: MouseRelease): boolean {
    const first = this.previous;
    if (
      first?.draftId === release.draftId &&
      release.timeStamp - first.timeStamp <= DOUBLE_CLICK_INTERVAL_MS &&
      Math.hypot(release.x - first.x, release.y - first.y) <=
        DOUBLE_CLICK_DISTANCE_PX
    ) {
      this.reset();
      return true;
    }
    this.previous = release;
    return false;
  }

  reset(): void {
    this.previous = undefined;
  }
}

export class TapGesture {
  private active: PointerStart | undefined;

  down(event: PointerStart): void {
    if (this.active) {
      this.active = undefined;
    } else if (event.primary && event.button === 0) {
      this.active = event;
    }
  }

  move(id: number, x: number, y: number): void {
    if (
      this.active?.id === id &&
      Math.hypot(x - this.active.x, y - this.active.y) > POINTER_SLOP_PX
    ) {
      this.active = undefined;
    }
  }

  up(id: number, x: number, y: number): boolean {
    this.move(id, x, y);
    if (this.active?.id !== id) return false;
    this.active = undefined;
    return true;
  }

  cancel(id?: number): void {
    if (id === undefined || this.active?.id === id) this.active = undefined;
  }
}
