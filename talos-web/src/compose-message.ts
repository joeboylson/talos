import { LIMITS } from "talos-shared";

export const canSendMessage = (typedText: string, imageCount: number): boolean =>
  typedText.trim() !== "" || imageCount > 0;

// Enter sends; Shift+Enter starts a new line.
export const isSendKey = ({ key, shiftKey }: { key: string; shiftKey: boolean }): boolean => key === "Enter" && !shiftKey;

export const takeImagesThatFit = <T>(files: T[], attachedCount: number): T[] =>
  files.slice(0, Math.max(0, LIMITS.maxImagesPerMessage - attachedCount));
