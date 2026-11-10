import type { QueueItem } from "./saveQueue";

export const queueStyles = {
  queued: { label: "Queued", stroke: "#66adff", dashed: true },
  sending: { label: "Saving…", stroke: "#b9a1ff", dashed: false },
  retrying: { label: "Retrying", stroke: "#ff9d54", dashed: true },
  paused: { label: "Paused", stroke: "#ef8feb", dashed: true },
  failed: { label: "Failed", stroke: "#ff7586", dashed: true },
} satisfies Record<
  QueueItem["state"]["status"],
  { label: string; stroke: string; dashed: boolean }
>;
