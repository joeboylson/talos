// Attach's command list, opened with Ctrl+P: what attach can do besides
// typing a message. Each item opens its own menu.
import { askChoice } from "./ask";
import { openLoopMenu } from "./loops";

const PALETTE_ITEMS = [{ value: "loop", label: "Loop", hint: "send a message on a schedule" }] as const;

// The line to show after it closes, or null when nothing happened.
export const openPalette = async (sessionName: string): Promise<string | null> => {
  const chosen = await askChoice("talos", PALETTE_ITEMS);
  if (chosen === "loop") return openLoopMenu(sessionName);
  return null;
};
