import { describe, expect, it } from "vitest";
import geometryCases from "../../fixtures/geometry.json";
import nameCases from "../../fixtures/names.json";
import {
  containsPoint,
  fitImage,
  normalizeName,
  toSourcePoint,
  validContour,
  validDraftContour,
  type Point,
} from "./geometry";

describe("shared validation rules", () => {
  it.each(geometryCases)("$case", ({ points, valid }) => {
    const pairs = points.map(([x, y]): Point => {
      if (x === undefined || y === undefined)
        throw new Error("Invalid fixture point");
      return [x, y];
    });
    expect(validContour(pairs)).toBe(valid);
  });

  it.each(nameCases)("normalizes $input", ({ input, output }) => {
    expect(normalizeName(input)).toBe(output);
  });

  it("counts Unicode code points", () => {
    expect(normalizeName("🚗".repeat(100))).toBe("🚗".repeat(100));
    expect(normalizeName("🚗".repeat(101))).toBeNull();
  });
});

describe("canvas coordinates", () => {
  it("preserves the source aspect ratio at small widths", () => {
    expect(fitImage(320, 1920, 1080)).toEqual({
      width: 320,
      height: 180,
      scale: 1 / 6,
    });
    expect(fitImage(400, 800, 1000)).toEqual({
      width: 400,
      height: 500,
      scale: 0.5,
    });
  });

  it("maps CSS coordinates through the inverse scale and ignores points outside the canvas", () => {
    const bounds = { left: 20, top: 10, width: 480, height: 270 };
    expect(toSourcePoint(260, 145, bounds, 1920, 1080)).toEqual([960, 540]);
    expect(toSourcePoint(19, 145, bounds, 1920, 1080)).toBeNull();
    expect(toSourcePoint(260, 281, bounds, 1920, 1080)).toBeNull();
  });
});

it("rejects unpaired surrogates and accepts genuine non-BMP characters", () => {
  expect(normalizeName(String.fromCharCode(0xd800))).toBeNull();
  expect(normalizeName("🚗")).toBe("🚗");
});

it("rejects structurally invalid contours and excludes a zero-sized view", () => {
  expect(
    validContour([
      [0, 0],
      [1, 1],
    ]),
  ).toBe(false);
  expect(
    validContour(Array.from({ length: 1001 }, (_, i): Point => [i, i])),
  ).toBe(false);
  expect(
    validContour([
      [0, 0],
      [Number.NaN, 1],
      [0, 1],
    ]),
  ).toBe(false);
  expect(
    validContour([
      [-1, 0],
      [1, 0],
      [0, 1],
    ]),
  ).toBe(false);
  expect(
    validContour([
      [1921, 0],
      [1, 0],
      [0, 1],
    ]),
  ).toBe(false);
  expect(
    validContour([
      [0, -1],
      [1, 0],
      [0, 1],
    ]),
  ).toBe(false);
  expect(
    validContour([
      [0, 1081],
      [1, 0],
      [0, 1],
    ]),
  ).toBe(false);
  expect(
    toSourcePoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }),
  ).toBeNull();
});

describe("visible draft geometry", () => {
  it("rejects a straight or nearly straight contour regardless of orientation", () => {
    expect(
      validDraftContour([
        [10, 50],
        [200, 50],
        [400, 50],
      ]),
    ).toBe(false);
    expect(
      validContour([
        [10, 50],
        [200, 50.25],
        [400, 50],
      ]),
    ).toBe(true);
    expect(
      validDraftContour([
        [10, 50],
        [200, 50.25],
        [400, 50],
      ]),
    ).toBe(false);
    expect(
      validDraftContour([
        [50, 10],
        [50.25, 200],
        [50, 400],
      ]),
    ).toBe(false);
    expect(
      validDraftContour([
        [500, 600],
        [200, 300.25],
        [10, 110],
      ]),
    ).toBe(false);
    expect(
      validDraftContour([
        [10, 50],
        [200, 58],
        [400, 50],
      ]),
    ).toBe(true);
    expect(
      validDraftContour([
        [50, 400],
        [58, 200],
        [50, 10],
      ]),
    ).toBe(true);
  });

  it("hit-tests the interior and boundary without filling a concave cutout", () => {
    const shape = [
      [0, 0],
      [100, 0],
      [100, 30],
      [30, 30],
      [30, 100],
      [0, 100],
    ] as const;
    expect(containsPoint(shape, [20, 80])).toBe(true);
    expect(containsPoint(shape, [30, 80])).toBe(true);
    expect(containsPoint(shape, [90, 30])).toBe(true);
    expect(containsPoint(shape, [31, 80])).toBe(false);
    expect(containsPoint(shape, [200, 30])).toBe(false);
    expect(containsPoint([], [1, 1])).toBe(false);
  });
});
