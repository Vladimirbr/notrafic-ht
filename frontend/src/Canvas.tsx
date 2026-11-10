import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent,
} from "react";
import { Stage } from "react-konva/lib/ReactKonvaCore";
import { OverlayLayer, SceneLayer, type CanvasShape } from "./CanvasLayers";
import type { QueueItem } from "./saveQueue";
import {
  fitImage,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  toSourcePoint,
  type Point,
} from "./geometry";
import { MouseReleasePair, POINTER_SLOP_PX, TapGesture } from "./gesture";

const EMPTY_QUEUE: readonly QueueItem[] = [];

type CanvasDraft = {
  points: readonly Point[];
  phase: "drawing" | "naming";
};
type CanvasProps = {
  image: HTMLImageElement | null;
  polygons: readonly CanvasShape[];
  draft: CanvasDraft | null;
  draftId?: string;
  queue?: readonly QueueItem[];
  deletingId?: number | null;
  drawing: boolean;
  idle?: boolean;
  selectedId?: number;
  onSceneKey?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPoint: (point: Point) => void;
  onClose?: () => void;
  canCloseFirst?: boolean;
  onMovePoint?: (index: number, point: Point) => void;
};

type VertexDrag = {
  id: number;
  index: number;
  origin: Point;
  points: readonly Point[];
  clientX: number;
  clientY: number;
  moved: boolean;
};

function dragPosition(
  drag: VertexDrag,
  event: ReactPointerEvent<HTMLDivElement>,
): Point | null {
  const dx = event.clientX - drag.clientX;
  const dy = event.clientY - drag.clientY;
  if (!drag.moved && Math.hypot(dx, dy) <= POINTER_SLOP_PX) return null;
  drag.moved = true;
  const { width, height } = event.currentTarget.getBoundingClientRect();
  if (width <= 0 || height <= 0) return null;
  const x = drag.origin[0] + (dx * IMAGE_WIDTH) / width;
  const y = drag.origin[1] + (dy * IMAGE_HEIGHT) / height;
  return [
    Math.max(0, Math.min(x, IMAGE_WIDTH)),
    Math.max(0, Math.min(y, IMAGE_HEIGHT)),
  ];
}

function isPrimaryMouse(event: ReactPointerEvent): boolean {
  return event.pointerType === "mouse" && event.isPrimary && event.button === 0;
}

export function PolygonCanvas({
  image,
  polygons,
  queue = EMPTY_QUEUE,
  deletingId = null,
  draft,
  draftId,
  drawing,
  idle = false,
  selectedId,
  onSceneKey,
  onPoint,
  onClose,
  canCloseFirst = true,
  onMovePoint,
}: CanvasProps) {
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef(new TapGesture());
  const mousePair = useRef(new MouseReleasePair());
  const [width, setWidth] = useState(0);
  const drag = useRef<VertexDrag | null>(null);
  const [preview, setPreview] = useState<{
    points: readonly Point[];
    index: number;
    point: Point;
  } | null>(null);

  function cancelDrag(id?: number) {
    if (drag.current && (id === undefined || drag.current.id === id)) {
      drag.current = null;
      setPreview(null);
    }
  }

  function finishMousePair(event: ReactPointerEvent<HTMLDivElement>): boolean {
    if (!drawing || draftId === undefined || !onClose || !isPrimaryMouse(event))
      return false;
    if (
      !mousePair.current.accept({
        draftId,
        x: event.clientX,
        y: event.clientY,
        timeStamp: event.timeStamp,
      })
    )
      return false;
    onClose();
    return true;
  }

  useLayoutEffect(() => {
    mousePair.current.reset();
  }, [draftId, drawing]);

  useLayoutEffect(() => {
    const element = surface.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        mousePair.current.reset();
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    const document = element.ownerDocument;
    const cancelMultiTouch = (event: PointerEvent) => {
      if (event.pointerType === "touch" && !event.isPrimary) {
        gesture.current.cancel();
        mousePair.current.reset();
        cancelDrag();
      }
    };
    document.addEventListener("pointerdown", cancelMultiTouch, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", cancelMultiTouch, true);
    };
  }, []);

  const canTap = drawing || idle;
  const fit = fitImage(width);
  const draftPoints =
    preview && preview.points === draft?.points
      ? draft.points.map((point, index) =>
          index === preview.index ? preview.point : point,
        )
      : draft?.points;
  return (
    <div
      ref={surface}
      role="img"
      aria-label="Polygon drawing canvas"
      aria-description={`${String(polygons.length)} saved polygons`}
      className="canvas-surface"
      data-drawing={canTap}
      tabIndex={
        onSceneKey ? (drawing || selectedId !== undefined ? 0 : -1) : undefined
      }
      onKeyDown={onSceneKey}
      onPointerDown={(event) => {
        if (!isPrimaryMouse(event)) mousePair.current.reset();
        if (canTap) {
          gesture.current.down({
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            primary: event.isPrimary,
            button: event.button,
          });
        }
      }}
      onPointerMove={(event) => {
        const vertex = drag.current;
        if (vertex?.id === event.pointerId) {
          const point = dragPosition(vertex, event);
          if (point)
            setPreview({ points: vertex.points, index: vertex.index, point });
        } else
          gesture.current.move(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        const vertex = drag.current;
        if (vertex?.id === event.pointerId) {
          const point = dragPosition(vertex, event);
          cancelDrag(event.pointerId);
          if (vertex.points !== draft?.points) {
            mousePair.current.reset();
            return;
          }
          if (
            !vertex.moved &&
            vertex.index > 0 &&
            vertex.index === draft.points.length - 1
          ) {
            finishMousePair(event);
          } else {
            mousePair.current.reset();
            if (point) onMovePoint?.(vertex.index, point);
            else if (!vertex.moved && vertex.index === 0 && canCloseFirst)
              onClose?.();
          }
          return;
        }
        if (
          !gesture.current.up(event.pointerId, event.clientX, event.clientY) ||
          !canTap
        ) {
          mousePair.current.reset();
          return;
        }
        const point = toSourcePoint(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
        );
        if (point) {
          if (onSceneKey) event.currentTarget.focus({ preventScroll: true });
          if (!finishMousePair(event)) onPoint(point);
        }
      }}
      onPointerCancel={(event) => {
        gesture.current.cancel(event.pointerId);
        mousePair.current.reset();
        cancelDrag(event.pointerId);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id === event.pointerId) {
          mousePair.current.reset();
          cancelDrag(event.pointerId);
        }
      }}
      onPointerLeave={(event) => {
        gesture.current.cancel(event.pointerId);
        mousePair.current.reset();
      }}
    >
      {width > 0 && image !== null && (
        <Stage
          width={fit.width}
          height={fit.height}
          scaleX={fit.scale}
          scaleY={fit.scale}
        >
          <SceneLayer
            image={image}
            polygons={polygons}
            selectedId={selectedId}
            deletingId={deletingId}
            scale={fit.scale}
          />
          <OverlayLayer
            queue={queue}
            points={draftPoints}
            closed={draft?.phase === "naming"}
            scale={fit.scale}
          />
        </Stage>
      )}
      {onMovePoint &&
        draft &&
        draftPoints?.map(([x, y], index) => (
          <span
            key={index}
            className="vertex-handle"
            data-close={index === 0 && canCloseFirst && Boolean(onClose)}
            aria-hidden="true"
            style={{
              left: `${String((x / IMAGE_WIDTH) * 100)}%`,
              top: `${String((y / IMAGE_HEIGHT) * 100)}%`,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!isPrimaryMouse(event)) mousePair.current.reset();
              const origin = draft.points[index];
              if (
                drag.current ||
                !event.isPrimary ||
                event.button !== 0 ||
                !origin
              )
                return;
              if (isPrimaryMouse(event)) event.preventDefault();
              gesture.current.cancel();
              drag.current = {
                id: event.pointerId,
                index,
                origin,
                points: draft.points,
                clientX: event.clientX,
                clientY: event.clientY,
                moved: false,
              };
              surface.current?.setPointerCapture(event.pointerId);
            }}
          />
        ))}
    </div>
  );
}
