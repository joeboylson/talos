import type { PageKind } from "talos-shared";

export const LOCAL_STATUS_CHECK_INTERVAL_MS = 5000;

export const VIEWS: Record<PageKind, { title: string }> = {
  machines: { title: "Machines" },
  folders: { title: "Folders" },
  settings: { title: "Settings" },
};

export type View = PageKind;
