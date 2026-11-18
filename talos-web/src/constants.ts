import type { PageKind } from "talos-shared";

export const LOCAL_STATUS_CHECK_INTERVAL_MS = 5000;

export const VIEWS: Record<PageKind, { title: string }> = {
  machines: { title: "Machines" },
  folders: { title: "Folders" },
  sessions: { title: "Sessions" },
  settings: { title: "Settings" },
};

export type View = PageKind;

// Images are shrunk to fit this many pixels on their longest side before
// sending: Claude scales big images down anyway, and smaller ones send fast.
export const MAX_IMAGE_SIDE_PX = 1600;
export const JPEG_QUALITY = 0.85;
