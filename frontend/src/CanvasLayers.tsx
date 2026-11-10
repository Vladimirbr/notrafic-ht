import { Fragment, memo, useMemo } from "react";
import {
  Circle,
  Image as SceneImage,
  Layer,
  Line,
} from "react-konva/lib/ReactKonvaCore";
import "konva/lib/shapes/Circle";
import "konva/lib/shapes/Image";
import "konva/lib/shapes/Line";
import { IMAGE_HEIGHT, IMAGE_WIDTH, type Point } from "./geometry";
import { queueStyles } from "./polygonStatus";
import type { QueueItem } from "./saveQueue";

export type CanvasShape = { id: number | string; points: readonly Point[] };

const CONTOUR_WIDTH_PX = 2.5;
const SELECTED_CONTOUR_WIDTH_PX = 4;
const VERTEX_RADIUS_PX = 4;
const VERTEX_STROKE_WIDTH_PX = 1.5;
const DRAFT_STROKE = "#ffce75";
const SAVED_STROKE = "#66ffe0";
const DELETING_STROKE = "#a8bad2";
const DARK_HALO = "#162328";
const SELECTED_HALO = "#f4fbff";
const OUTLINE_DASH_PX = [7, 4] as const;

export const SceneLayer = memo(function SceneLayer({
  image,
  polygons,
  selectedId,
  deletingId,
  scale,
}: {
  image: HTMLImageElement;
  polygons: readonly CanvasShape[];
  selectedId: number | undefined;
  deletingId: number | null;
  scale: number;
}) {
  const contours = useMemo(
    () => polygons.map(({ id, points }) => ({ id, path: points.flat() })),
    [polygons],
  );
  const dash = OUTLINE_DASH_PX.map((length) => length / scale);
  return (
    <Layer listening={false}>
      <SceneImage image={image} width={IMAGE_WIDTH} height={IMAGE_HEIGHT} />
      {contours.map(({ id, path }) => (
        <Fragment key={id}>
          {id === selectedId && (
            <Line
              points={path}
              closed
              stroke={SELECTED_HALO}
              strokeWidth={
                (SELECTED_CONTOUR_WIDTH_PX + CONTOUR_WIDTH_PX) / scale
              }
              shadowColor={DARK_HALO}
              shadowBlur={3 / scale}
              lineJoin="round"
            />
          )}
          <Line
            points={path}
            closed
            fill={
              id === selectedId
                ? "rgba(71, 144, 255, 0.35)"
                : "rgba(14, 181, 140, 0.28)"
            }
            stroke={id === deletingId ? DELETING_STROKE : SAVED_STROKE}
            dash={id === deletingId ? dash : undefined}
            shadowColor={DARK_HALO}
            shadowBlur={id === selectedId ? 0 : 3 / scale}
            shadowForStrokeEnabled
            strokeWidth={
              (id === selectedId
                ? SELECTED_CONTOUR_WIDTH_PX
                : CONTOUR_WIDTH_PX) / scale
            }
            lineJoin="round"
          />
        </Fragment>
      ))}
    </Layer>
  );
});

const QueuedContours = memo(function QueuedContours({
  queue,
  scale,
}: {
  queue: readonly QueueItem[];
  scale: number;
}) {
  return queue.map(({ sequence, submission, state }) => (
    <QueuedContour
      key={sequence}
      points={submission.body.points}
      status={state.status}
      scale={scale}
    />
  ));
});

const QueuedContour = memo(function QueuedContour({
  points,
  status,
  scale,
}: {
  points: readonly Point[];
  status: QueueItem["state"]["status"];
  scale: number;
}) {
  const path = useMemo(() => points.flat(), [points]);
  const style = queueStyles[status];
  return (
    <Line
      points={path}
      closed
      stroke={style.stroke}
      dash={
        style.dashed
          ? OUTLINE_DASH_PX.map((length) => length / scale)
          : undefined
      }
      strokeWidth={CONTOUR_WIDTH_PX / scale}
      shadowColor={DARK_HALO}
      shadowBlur={3 / scale}
      shadowForStrokeEnabled
      lineJoin="round"
    />
  );
});

export const OverlayLayer = memo(function OverlayLayer({
  queue,
  points,
  closed,
  scale,
}: {
  queue: readonly QueueItem[];
  points: readonly Point[] | undefined;
  closed: boolean;
  scale: number;
}) {
  return (
    <Layer listening={false}>
      <QueuedContours queue={queue} scale={scale} />
      {points && (
        <>
          <Line
            points={points.flat()}
            closed={closed}
            fill="rgba(255, 191, 71, 0.25)"
            stroke={DRAFT_STROKE}
            strokeWidth={CONTOUR_WIDTH_PX / scale}
            shadowColor={DARK_HALO}
            shadowBlur={3 / scale}
            shadowForStrokeEnabled
            lineCap="round"
            lineJoin="round"
          />
          {points.map(([x, y], index) => (
            <Circle
              key={index}
              x={x}
              y={y}
              radius={VERTEX_RADIUS_PX / scale}
              fill={DRAFT_STROKE}
              stroke="#292015"
              strokeWidth={VERTEX_STROKE_WIDTH_PX / scale}
            />
          ))}
        </>
      )}
    </Layer>
  );
});
