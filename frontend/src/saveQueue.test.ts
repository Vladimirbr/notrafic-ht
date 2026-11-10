import { expect, it } from "vitest";
import { nextAttempt, unsavedOutcome } from "./saveQueue";

it("retries at the persisted deadline and spends at most four attempts", () => {
  expect(nextAttempt({ status: "queued" }, 100)).toEqual({
    status: "sending",
    attempts: 1,
  });
  expect(
    nextAttempt({ status: "retrying", attempts: 1, retryAt: 2100 }, 2099),
  ).toBeNull();
  expect(
    nextAttempt({ status: "retrying", attempts: 1, retryAt: 2100 }, 2100),
  ).toEqual({ status: "sending", attempts: 2 });
  expect(nextAttempt({ status: "sending", attempts: 3 }, 100)).toEqual({
    status: "sending",
    attempts: 4,
  });
  expect(nextAttempt({ status: "sending", attempts: 4 }, 100)).toEqual({
    status: "paused",
  });
  expect(nextAttempt({ status: "paused" }, 23000)).toBeNull();
});

it("backs off unknown results and retains definitive failures", () => {
  expect(unsavedOutcome(1, "unknown", 100)).toEqual({
    status: "retrying",
    attempts: 1,
    retryAt: 2100,
  });
  expect(unsavedOutcome(2, "unknown", 300)).toEqual({
    status: "retrying",
    attempts: 2,
    retryAt: 5300,
  });
  expect(unsavedOutcome(3, "unknown", 500)).toEqual({
    status: "retrying",
    attempts: 3,
    retryAt: 15500,
  });
  expect(unsavedOutcome(4, "unknown", 600)).toEqual({ status: "paused" });
  expect(unsavedOutcome(1, "invalid", 100)).toEqual({
    status: "failed",
    reason: "invalid",
  });
});
