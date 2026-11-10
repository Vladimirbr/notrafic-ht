import { expect, it } from "vitest";
import { MouseReleasePair, TapGesture } from "./gesture";

it("emits one tap only for a primary pointer released within the movement threshold", () => {
  const gesture = new TapGesture();
  gesture.down({ id: 1, x: 2, y: 3, primary: false, button: 0 });
  expect(gesture.up(1, 2, 3)).toBe(false);
  gesture.down({ id: 1, x: 2, y: 3, primary: true, button: 2 });
  expect(gesture.up(1, 2, 3)).toBe(false);
  gesture.down({ id: 1, x: 2, y: 3, primary: true, button: 0 });
  gesture.move(1, 3, 4);
  expect(gesture.up(1, 4, 5)).toBe(true);
  expect(gesture.up(1, 4, 5)).toBe(false);
});

it("cancels a swipe, a distant release, a second pointer and explicit cancellation", () => {
  const gesture = new TapGesture();
  const start = () => {
    gesture.down({ id: 1, x: 0, y: 0, primary: true, button: 0 });
  };
  start();
  gesture.move(2, 0, 30);
  gesture.move(1, 0, 20);
  expect(gesture.up(1, 0, 0)).toBe(false);
  start();
  expect(gesture.up(1, 0, 20)).toBe(false);
  start();
  gesture.down({ id: 2, x: 0, y: 0, primary: false, button: 0 });
  expect(gesture.up(2, 0, 0)).toBe(false);
  expect(gesture.up(1, 0, 0)).toBe(false);
  start();
  gesture.cancel(1);
  expect(gesture.up(1, 0, 0)).toBe(false);
});

const firstRelease = { draftId: "draft-a", x: 100, y: 100, timeStamp: 1000 };

it("pairs mouse releases at the time and distance limits and consumes the pair", () => {
  const pair = new MouseReleasePair();
  expect(pair.accept(firstRelease)).toBe(false);
  expect(pair.accept({ ...firstRelease, x: 104, timeStamp: 1400 })).toBe(true);
  expect(pair.accept({ ...firstRelease, x: 104, timeStamp: 1401 })).toBe(false);
});

it.each([
  { draftId: "draft-b", timeStamp: 1010 },
  { x: 103, y: 103, timeStamp: 1010 },
  { timeStamp: 1401 },
])("starts a new pair after a different draft, position or time %j", (next) => {
  const pair = new MouseReleasePair();
  const secondRelease = { ...firstRelease, ...next };
  expect(pair.accept(firstRelease)).toBe(false);
  expect(pair.accept(secondRelease)).toBe(false);
  expect(pair.accept({ ...secondRelease, timeStamp: 1402 })).toBe(true);
});

it("clears a pending mouse release when the gesture is canceled", () => {
  const pair = new MouseReleasePair();
  expect(pair.accept(firstRelease)).toBe(false);
  pair.reset();
  expect(pair.accept({ ...firstRelease, timeStamp: 1001 })).toBe(false);
});
