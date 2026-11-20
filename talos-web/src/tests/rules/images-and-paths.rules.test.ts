import { expect, test } from "bun:test";
import fc from "fast-check";
import { buildLocationPath, readPageLocation } from "../../hooks/use-page-path";
import { fitWithin } from "../../images";

test("fitWithin never grows an image, fits the longest side, and keeps its shape", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 1, max: 4000 }), (width, height, maxSide) => {
      const fitted = fitWithin(width, height, maxSide);
      const scale = Math.min(1, maxSide / Math.max(width, height));
      expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(Math.max(maxSide, 0));
      expect(fitted.width).toBeLessThanOrEqual(width);
      expect(fitted.height).toBeLessThanOrEqual(height);
      expect(Math.abs(fitted.width - width * scale)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(fitted.height - height * scale)).toBeLessThanOrEqual(0.5);
    }),
    { seed: 20261125, numRuns: 5000 },
  );
});

test("a session's address reads back as the same session", () => {
  const part = fc.string({ minLength: 1, maxLength: 12, unit: "grapheme" });
  fc.assert(
    fc.property(part, part, (machineName, sessionName) => {
      const location = { pageKind: "sessions", machineName, sessionName } as const;
      expect(readPageLocation(buildLocationPath(location))).toEqual(location);
    }),
    { seed: 20261126, numRuns: 3000 },
  );
});
