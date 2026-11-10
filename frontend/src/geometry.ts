export const IMAGE_WIDTH = 1920;
export const IMAGE_HEIGHT = 1080;
export const MIN_VERTICES = 3;
export const MAX_VERTICES = 1000;
export const MAX_NAME_LENGTH = 100;
const GRID_UNITS_PER_PIXEL = 1000;
const MIN_DRAFT_SPREAD = 6;
const NAME_SPACE = /[\p{White_Space}\uFEFF]/u;
const NON_NAME_SPACE = /[^\p{White_Space}\uFEFF]/u;
export type Point = readonly [number, number];
type Edge = readonly [Point, Point];

export function inImageBounds([x, y]: Point): boolean {
  return 0 <= x && x <= IMAGE_WIDTH && 0 <= y && y <= IMAGE_HEIGHT;
}

export function normalizeName(raw: string): string | null {
  const start = raw.search(NON_NAME_SPACE);
  if (start < 0) return null;
  let end = raw.length;
  while (NAME_SPACE.test(raw.charAt(end - 1))) end--;

  const name = raw.slice(start, end);
  let length = 0;
  for (const character of name) {
    length++;
    if (length > MAX_NAME_LENGTH || /[\0\uD800-\uDFFF]/u.test(character))
      return null;
  }
  return name;
}

function turn(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function within(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = turn(a, b, c);
  const abD = turn(a, b, d);
  const cdA = turn(c, d, a);
  const cdB = turn(c, d, b);
  return (
    (abC * abD < 0 && cdA * cdB < 0) ||
    (abC === 0 && within(a, b, c)) ||
    (abD === 0 && within(a, b, d)) ||
    (cdA === 0 && within(c, d, a)) ||
    (cdB === 0 && within(c, d, b))
  );
}

export function validContour(points: readonly Point[]): boolean {
  if (points.length < MIN_VERTICES || points.length > MAX_VERTICES)
    return false;
  const grid: Point[] = [];
  for (const point of points) {
    if (!inImageBounds(point)) return false;
    const [x, y] = point;
    grid.push([
      Math.floor(x * GRID_UNITS_PER_PIXEL + 0.5),
      Math.floor(y * GRID_UNITS_PER_PIXEL + 0.5),
    ]);
  }

  const [first] = grid;
  if (
    !first ||
    new Set(grid.map(([x, y]) => `${String(x)}:${String(y)}`)).size !==
      grid.length
  )
    return false;
  const edges = grid.map((point, index): Edge => [
    point,
    grid[index + 1] ?? first,
  ]);
  if (edges.reduce((area, [a, b]) => area + a[0] * b[1] - a[1] * b[0], 0) === 0)
    return false;

  for (const [index, [a, b]] of edges.entries()) {
    const c = grid[index + 2] ?? (index === edges.length - 2 ? first : grid[1]);
    if (
      c &&
      turn(a, b, c) === 0 &&
      (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0
    ) {
      return false;
    }
    const end = edges.length - Number(index === 0);
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    for (let other = index + 2; other < end; other++) {
      const edge = edges[other];
      if (!edge) break;
      const [c, d] = edge;
      // Keep touching bounds so the exact intersection check can reject them.
      if (
        (c[0] < minX && d[0] < minX) ||
        (c[0] > maxX && d[0] > maxX) ||
        (c[1] < minY && d[1] < minY) ||
        (c[1] > maxY && d[1] > maxY)
      )
        continue;
      if (intersects(a, b, c, d)) return false;
    }
  }
  return true;
}

export function validDraftContour(points: readonly Point[]): boolean {
  const first = points[0];
  if (!first || !validContour(points)) return false;

  // Use the longer bounding axis and a stable tie-break for each endpoint.
  const byX = (a: Point, b: Point) => a[0] - b[0] || a[1] - b[1];
  const byY = (a: Point, b: Point) => a[1] - b[1] || a[0] - b[0];
  let left = first;
  let right = first;
  let top = first;
  let bottom = first;
  for (const point of points) {
    if (byX(point, left) < 0) left = point;
    if (byX(point, right) > 0) right = point;
    if (byY(point, top) < 0) top = point;
    if (byY(point, bottom) > 0) bottom = point;
  }
  const [a, b] =
    right[0] - left[0] >= bottom[1] - top[1] ? [left, right] : [top, bottom];
  let low = 0;
  let high = 0;
  for (const point of points) {
    const offset = turn(a, b, point);
    low = Math.min(low, offset);
    high = Math.max(high, offset);
  }
  return high - low >= MIN_DRAFT_SPREAD * Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function containsPoint(points: readonly Point[], point: Point): boolean {
  let a = points.at(-1);
  if (!a) return false;
  let inside = false;
  const [x, y] = point;
  for (const b of points) {
    if (turn(a, b, point) === 0 && within(a, b, point)) return true;
    if (
      a[1] > y !== b[1] > y &&
      x < a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1])
    ) {
      inside = !inside;
    }
    a = b;
  }
  return inside;
}

export function fitImage(
  width: number,
  sourceWidth = IMAGE_WIDTH,
  sourceHeight = IMAGE_HEIGHT,
) {
  const scale = width / sourceWidth;
  return { width, height: sourceHeight * scale, scale };
}

export function toSourcePoint(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
  width = IMAGE_WIDTH,
  height = IMAGE_HEIGHT,
): Point | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const nx = (x - bounds.left) / bounds.width;
  const ny = (y - bounds.top) / bounds.height;
  return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1
    ? [nx * width, ny * height]
    : null;
}
