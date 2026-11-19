import { LIMITS, type SentImage } from "talos-shared";
import { JPEG_QUALITY, MAX_IMAGE_SIDE_PX } from "@/constants";

// An image ready to send, and a link to show it on the page meanwhile.
export type PreparedImage = SentImage & { previewUrl: string };

const BASE64_BYTES_PER_CHARACTER = 3 / 4;
const MAX_IMAGE_BYTES = Math.floor(LIMITS.maxImageBase64Length * BASE64_BYTES_PER_CHARACTER);

export const fitWithin = (width: number, height: number, maxSide: number): { width: number; height: number } => {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

const canvasToBlob = (canvas: HTMLCanvasElement, mediaType: SentImage["mediaType"]): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("couldn't read that image"))),
      mediaType,
      JPEG_QUALITY,
    ),
  );

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Screenshots stay PNG so their text stays sharp, unless that's too big;
// everything else becomes JPEG.
export const prepareImage = async (file: Blob): Promise<PreparedImage> => {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_SIDE_PX);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const pngBlob = file.type === "image/png" ? await canvasToBlob(canvas, "image/png") : null;
  const isPngSmallEnough = pngBlob !== null && pngBlob.size <= MAX_IMAGE_BYTES;
  const blob = isPngSmallEnough ? pngBlob : await canvasToBlob(canvas, "image/jpeg");
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("That image is too big");
  const mediaType = isPngSmallEnough ? "image/png" : "image/jpeg";
  return { mediaType, dataBase64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob) };
};
