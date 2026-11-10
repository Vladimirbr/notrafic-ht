from math import floor

type Point = tuple[float, float]
type GridPoint = tuple[int, int]

IMAGE_WIDTH = 1920
IMAGE_HEIGHT = 1080
MIN_VERTICES = 3
MAX_VERTICES = 1000
MAX_NAME_LENGTH = 100
GRID_UNITS_PER_PIXEL = 1000

# Unicode White_Space plus the byte-order mark, shared with the browser.
NAME_SPACE = "\t\n\v\f\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def normalize_name(raw: str) -> str:
    name = raw.strip(NAME_SPACE)
    if not 1 <= len(name) <= MAX_NAME_LENGTH:
        raise ValueError(f"Enter a name of 1 to {MAX_NAME_LENGTH} characters.")
    if any(char == "\0" or 0xD800 <= ord(char) <= 0xDFFF for char in name):
        raise ValueError("The name contains an invalid character.")
    return name


def _turn(a: GridPoint, b: GridPoint, c: GridPoint) -> int:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _within(a: GridPoint, b: GridPoint, p: GridPoint) -> bool:
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def _intersects(a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint) -> bool:
    ab_c, ab_d = _turn(a, b, c), _turn(a, b, d)
    cd_a, cd_b = _turn(c, d, a), _turn(c, d, b)
    return (
        ab_c * ab_d < 0
        and cd_a * cd_b < 0
        or ab_c == 0
        and _within(a, b, c)
        or ab_d == 0
        and _within(a, b, d)
        or cd_a == 0
        and _within(c, d, a)
        or cd_b == 0
        and _within(c, d, b)
    )


def validate_polygon(points: tuple[Point, ...]) -> None:
    grid = [
        (floor(x * GRID_UNITS_PER_PIXEL + 0.5), floor(y * GRID_UNITS_PER_PIXEL + 0.5))
        for x, y in points
    ]
    if len(set(grid)) != len(grid):
        raise ValueError("Vertices must be distinct.")

    edges = list(zip(grid, grid[1:] + grid[:1], strict=True))
    if sum(a[0] * b[1] - a[1] * b[0] for a, b in edges) == 0:
        raise ValueError("The polygon needs a nonzero area.")

    for index, (a, b) in enumerate(edges):
        _, c = edges[(index + 1) % len(edges)]
        if (
            _turn(a, b, c) == 0
            and (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0
        ):
            raise ValueError("Adjacent edges overlap.")
        end = len(edges) - (index == 0)
        min_x, max_x = min(a[0], b[0]), max(a[0], b[0])
        min_y, max_y = min(a[1], b[1]), max(a[1], b[1])
        for other in range(index + 2, end):
            c, d = edges[other]
            # Keep touching bounds so the exact intersection check can reject them.
            if (
                c[0] < min_x
                and d[0] < min_x
                or c[0] > max_x
                and d[0] > max_x
                or c[1] < min_y
                and d[1] < min_y
                or c[1] > max_y
                and d[1] > max_y
            ):
                continue
            if _intersects(a, b, c, d):
                raise ValueError("The polygon crosses or touches itself.")
