import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PolygonCanvas } from "./Canvas";
import { validDraftContour, type Point } from "./geometry";
import "./styles.css";

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

afterEach(() => {
  flushSync(() => {
    root.render(null);
  });
});

it("renders an actual Konva canvas and preserves source coordinates after resizing", async () => {
  const image = new Image(1920, 1080);
  image.src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'><rect width='1920' height='1080' fill='blue'/></svg>";
  await image.decode();
  const addPoint = vi.fn();
  container.style.width = "480px";
  flushSync(() => {
    root.render(
      <PolygonCanvas
        image={image}
        polygons={[]}
        draft={null}
        drawing
        onPoint={addPoint}
      />,
    );
  });

  const surface = page.getByRole("img", { name: "Polygon drawing canvas" });
  await expect.element(surface).toBeVisible();
  await expect
    .poll(
      () => container.querySelector("canvas")?.getBoundingClientRect().width,
    )
    .toBe(480);
  await surface.click({ position: { x: 120, y: 90 } });
  expect(addPoint).toHaveBeenLastCalledWith([480, 360]);

  container.style.width = "240px";
  await expect
    .poll(
      () => container.querySelector("canvas")?.getBoundingClientRect().height,
    )
    .toBe(135);
  await surface.click({ position: { x: 60, y: 45 } });
  expect(addPoint).toHaveBeenLastCalledWith([480, 360]);
  expect(addPoint).toHaveBeenCalledTimes(2);
});

it("draws saved and draft contours into the bitmap and ignores gestures outside drawing mode", async () => {
  const image = new Image(1920, 1080);
  image.src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'><rect width='1920' height='1080' fill='blue'/></svg>";
  await image.decode();
  const onPoint = vi.fn();
  container.style.width = "480px";
  flushSync(() => {
    root.render(
      <PolygonCanvas
        image={image}
        polygons={[
          {
            id: 1,
            points: [
              [100, 100],
              [600, 100],
              [100, 600],
            ],
          },
        ]}
        draft={{
          phase: "naming",
          points: [
            [1000, 100],
            [1500, 100],
            [1000, 600],
          ],
        }}
        drawing={false}
        onPoint={onPoint}
      />,
    );
  });
  const surface = page.getByRole("img", { name: "Polygon drawing canvas" });
  await expect
    .element(surface)
    .toHaveAttribute("aria-description", "1 saved polygons");
  await expect
    .poll(
      () => container.querySelector("canvas")?.getBoundingClientRect().width,
    )
    .toBe(480);
  const [sceneCanvas, draftCanvas] = container.querySelectorAll("canvas");
  function pixelAt(
    canvas: HTMLCanvasElement | undefined,
    x: number,
    y: number,
  ) {
    const ratio = (canvas?.width ?? 0) / 480;
    return Array.from(
      canvas?.getContext("2d")?.getImageData(x * ratio, y * ratio, 1, 1).data ??
        [],
    );
  }
  const background = pixelAt(sceneCanvas, 200, 200);
  expect(background).toEqual([0, 0, 255, 255]);
  expect(pixelAt(sceneCanvas, 60, 60)).not.toEqual(background);
  expect(pixelAt(sceneCanvas, 280, 60)).toEqual(background);
  expect(pixelAt(draftCanvas, 280, 60)[3]).toBeGreaterThan(0);
  await surface.click({ position: { x: 60, y: 60 } });
  expect(onPoint).not.toHaveBeenCalled();
});

it("closes at the first handle and only commits a drag on release", async () => {
  const image = new Image(1920, 1080);
  image.src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'/>";
  await image.decode();
  const onPoint = vi.fn();
  const onClose = vi.fn();
  const onMovePoint = vi.fn();
  container.style.width = "480px";
  flushSync(() => {
    root.render(
      <PolygonCanvas
        image={image}
        polygons={[]}
        draft={{
          phase: "drawing",
          points: [
            [480, 270],
            [1440, 270],
            [960, 810],
          ],
        }}
        drawing
        onPoint={onPoint}
        onClose={onClose}
        onMovePoint={onMovePoint}
      />,
    );
  });
  const canvas = page.getByRole("img", { name: "Polygon drawing canvas" });
  await expect.element(canvas).toBeVisible();
  await canvas.click({ position: { x: 120, y: 68 } });
  await canvas.click({ position: { x: 360, y: 68 } });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onPoint).not.toHaveBeenCalled();

  const surface = canvas.element();
  const second = surface.querySelector<HTMLElement>(
    ".vertex-handle:nth-last-child(2)",
  );
  if (!second) throw new Error("Expected an editable vertex.");
  const capture = vi
    .spyOn(surface, "setPointerCapture")
    .mockImplementation(() => {});
  function send(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    options: PointerEventInit = {},
  ) {
    flushSync(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          bubbles: true,
          clientX: x,
          clientY: y,
          ...options,
        }),
      );
    });
  }

  send(second, "pointerdown", 360, 68);
  expect(capture).toHaveBeenCalledWith(7);
  send(surface, "pointermove", 365, 71);
  expect(second.style.left).toBe("75%");
  send(surface, "pointermove", 384, 95);
  await expect.poll(() => second.style.left).toBe("80%");
  expect(onMovePoint).not.toHaveBeenCalled();
  send(surface, "pointercancel", 384, 95);
  expect(second.style.left).toBe("75%");

  send(second, "pointerdown", 360, 68);
  send(surface, "pointermove", 384, 95);
  send(document.body, "pointerdown", 100, 100, {
    pointerId: 8,
    isPrimary: false,
  });
  send(surface, "pointerup", 384, 95);
  expect(second.style.left).toBe("75%");
  expect(onMovePoint).not.toHaveBeenCalled();

  send(second, "pointerdown", 360, 68);
  send(surface, "pointermove", 384, 95);
  send(surface, "pointerup", 384, 95);
  expect(onMovePoint).toHaveBeenCalledExactlyOnceWith(1, [1536, 378]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onPoint).not.toHaveBeenCalled();
});

async function renderDrawing(initialPoints: readonly Point[]) {
  const image = new Image(1920, 1080);
  image.src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'/>";
  await image.decode();
  function Drawing() {
    const [points, setPoints] = useState(initialPoints);
    const [naming, setNaming] = useState(false);
    const contourValid = validDraftContour(points);
    return (
      <>
        <PolygonCanvas
          image={image}
          polygons={[]}
          draft={{ phase: naming ? "naming" : "drawing", points }}
          draftId="active-draft"
          drawing={!naming}
          canCloseFirst={contourValid}
          onPoint={(point) => {
            setPoints([...points, point]);
          }}
          onMovePoint={(index, point) => {
            setPoints(points.map((old, i) => (i === index ? point : old)));
          }}
          onClose={
            naming
              ? undefined
              : () => {
                  if (contourValid) setNaming(true);
                }
          }
        />
        {naming && <input aria-label="Polygon name" />}
      </>
    );
  }
  container.style.width = "480px";
  flushSync(() => {
    root.render(<Drawing />);
  });
  const surface = page.getByRole("img", { name: "Polygon drawing canvas" });
  await expect.element(surface).toBeVisible();
  await expect
    .poll(
      () => container.querySelector("canvas")?.getBoundingClientRect().width,
    )
    .toBe(480);
  const handles = () => surface.element().querySelectorAll(".vertex-handle");
  return {
    surface,
    handles,
    handle: (index: number) => {
      const handle = handles()[index];
      if (!handle) throw new Error("Expected an editable vertex.");
      return handle;
    },
    name: page.getByRole("textbox", { name: "Polygon name" }),
  };
}

const firstTwo: readonly Point[] = [
  [480, 270],
  [1440, 270],
];

it("adds one final point on a real double-click from the surface onto a new handle", async () => {
  const { surface, handles, name } = await renderDrawing(firstTwo);
  await surface.dblClick({ position: { x: 240, y: 202 } });
  await expect.element(name).toBeVisible();
  expect(handles()).toHaveLength(3);
});

it("finishes on a real double-click on the last existing handle", async () => {
  const { handle, handles, name } = await renderDrawing([
    ...firstTwo,
    [960, 808],
  ]);
  await userEvent.dblClick(handle(2));
  await expect.element(name).toBeVisible();
  expect(handles()).toHaveLength(3);
});

it("keeps an invalid contour editable after a real double-click", async () => {
  const { surface, handles, name } = await renderDrawing([
    [480, 272],
    [960, 272],
  ]);
  await surface.dblClick({ position: { x: 360, y: 68 } });
  expect(handles()).toHaveLength(3);
  await expect.element(name).not.toBeInTheDocument();
  await surface.click({ position: { x: 240, y: 202 } });
  expect(handles()).toHaveLength(4);
});

it("leaves the name form intact on a real double-click on the first handle", async () => {
  const { handle, handles, name } = await renderDrawing([
    ...firstTwo,
    [960, 808],
  ]);
  await userEvent.dblClick(handle(0));
  await expect.element(name).toBeVisible();
  expect(handles()).toHaveLength(3);
});

it("adds two points when quick releases are more than four CSS pixels apart", async () => {
  const { surface, handles, name } = await renderDrawing(firstTwo);
  await surface.click({ position: { x: 240, y: 202 } });
  await surface.click({ position: { x: 256, y: 202 } });
  expect(handles()).toHaveLength(4);
  await expect.element(name).not.toBeInTheDocument();
});

it("starts a new pair when the canvas resizes between releases", async () => {
  const { surface, handles, name } = await renderDrawing(firstTwo);
  await surface.click({ position: { x: 240, y: 202 } });
  container.style.width = "420px";
  await expect
    .poll(
      () => container.querySelector("canvas")?.getBoundingClientRect().width,
    )
    .toBe(420);
  await surface.click({ position: { x: 240, y: 202 } });
  expect(handles()).toHaveLength(4);
  await expect.element(name).not.toBeInTheDocument();
});
