import { normalisedPoint } from "../../src/lib/pointerMapping";

const rect = { left: 100, top: 50, width: 252, height: 540 };

test("maps a point inside the screen to 0..1", () => {
  expect(normalisedPoint(226, 320, rect)).toEqual({ x: 0.5, y: 0.5 });
  expect(normalisedPoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
});

test("is undefined outside the screen, so a stray click is not a tap", () => {
  expect(normalisedPoint(99, 320, rect)).toBeUndefined();
  expect(normalisedPoint(226, 591, rect)).toBeUndefined();
});

test("is undefined for a zero-size screen instead of dividing by zero", () => {
  expect(normalisedPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBeUndefined();
});
