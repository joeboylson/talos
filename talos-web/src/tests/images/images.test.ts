import { describe, expect, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { MAX_IMAGE_BYTES, encodeWithinLimit, fitWithin, readBase64FromDataUrl } from "../../images";

test.each([
  [3200, 1600, 1600, { width: 1600, height: 800 }],
  [1000, 4000, 1600, { width: 400, height: 1600 }],
  [800, 600, 1600, { width: 800, height: 600 }],
  [3, 1000, 600, { width: 2, height: 600 }],
])("fitWithin %#", (width, height, maxSide, fitted) => {
  expect(fitWithin(width, height, maxSide)).toEqual(fitted);
});

test("the byte limit is the most whose base64 fits the server's limit", () => {
  const base64LengthOf = (byteCount: number) => Math.ceil(byteCount / 3) * 4;
  expect(base64LengthOf(MAX_IMAGE_BYTES)).toBeLessThanOrEqual(LIMITS.maxImageBase64Length);
  expect(base64LengthOf(MAX_IMAGE_BYTES + 3)).toBeGreaterThan(LIMITS.maxImageBase64Length);
});

describe("encodeWithinLimit", () => {
  const blobOf = (byteCount: number) => new Blob([new Uint8Array(byteCount)]);
  const encoderWith = (pngBytes: number, jpegBytes: number) => {
    const asked: string[] = [];
    const encode = async (mediaType: string) => {
      asked.push(mediaType);
      return blobOf(mediaType === "image/png" ? pngBytes : jpegBytes);
    };
    return { asked, encode };
  };

  test("keeps a PNG that fits, right up to the limit", async () => {
    const { asked, encode } = encoderWith(MAX_IMAGE_BYTES, 10);
    const encoded = await encodeWithinLimit("image/png", encode);
    expect(encoded.mediaType).toBe("image/png");
    expect(encoded.blob.size).toBe(MAX_IMAGE_BYTES);
    expect(asked).toEqual(["image/png"]);
  });

  test("turns a PNG that's too big into JPEG", async () => {
    const { encode } = encoderWith(MAX_IMAGE_BYTES + 1, 10);
    const encoded = await encodeWithinLimit("image/png", encode);
    expect(encoded).toMatchObject({ mediaType: "image/jpeg", blob: { size: 10 } });
  });

  test("turns anything else into JPEG without trying PNG", async () => {
    const { asked, encode } = encoderWith(10, 20);
    const encoded = await encodeWithinLimit("image/webp", encode);
    expect(encoded).toMatchObject({ mediaType: "image/jpeg", blob: { size: 20 } });
    expect(asked).toEqual(["image/jpeg"]);
  });

  test("refuses an image still too big as JPEG", async () => {
    const { encode } = encoderWith(MAX_IMAGE_BYTES + 1, MAX_IMAGE_BYTES + 1);
    await expect(encodeWithinLimit("image/png", encode)).rejects.toThrow("That image is too big");
  });

  test("allows a JPEG right at the limit", async () => {
    const { encode } = encoderWith(0, MAX_IMAGE_BYTES);
    expect((await encodeWithinLimit("image/jpeg", encode)).blob.size).toBe(MAX_IMAGE_BYTES);
  });
});

test("readBase64FromDataUrl keeps only the data", () => {
  expect(readBase64FromDataUrl("data:image/png;base64,iVBORw0")).toBe("iVBORw0");
  expect(readBase64FromDataUrl("nothing")).toBe("");
});
