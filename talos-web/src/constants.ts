export const LOCAL_STATUS_CHECK_INTERVAL_MS = 5000;

export const VIEWS = {
  machines: { title: "Machines" },
  settings: { title: "Settings" },
} as const;

export type View = keyof typeof VIEWS;
