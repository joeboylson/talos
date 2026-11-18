import { expect, test } from "bun:test";
import { fitWithin } from "../../images";

test.each([
  [3200, 1600, 1600, { width: 1600, height: 800 }],
  [1000, 4000, 1600, { width: 400, height: 1600 }],
  [800, 600, 1600, { width: 800, height: 600 }],
])("fitWithin %#", (width, height, maxSide, fitted) => {
  expect(fitWithin(width, height, maxSide)).toEqual(fitted);
});
