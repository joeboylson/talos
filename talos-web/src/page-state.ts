import { LIMITS, mergeSessionEntries, type MachineSummary, type ServerToPage, type SessionEntry } from "talos-shared";
import { removeAnsweredPrompt, sessionKey, type WaitingPrompt } from "@/session-rows";

export type PageState = {
  machines: MachineSummary[] | null;
  roundTripMsByMachineId: Record<string, number>;
  entriesBySession: Record<string, SessionEntry[]>;
  waitingPromptsBySession: Record<string, WaitingPrompt[]>;
  notice: string | null;
};

export const EMPTY_PAGE_STATE: PageState = {
  machines: null,
  roundTripMsByMachineId: {},
  entriesBySession: {},
  waitingPromptsBySession: {},
  notice: null,
};

export const applyServerMessage = (state: PageState, message: ServerToPage): PageState => {
  if (message.type === "machines") return { ...state, machines: message.machines };
  if (message.type === "error") return { ...state, notice: message.message };
  if (message.type === "pong") {
    return { ...state, roundTripMsByMachineId: { ...state.roundTripMsByMachineId, [message.machineId]: message.roundTripMs } };
  }
  const key = sessionKey(message.machineId, message.sessionName);
  const savedPrompts = message.entries.filter((entry) => entry.kind === "prompt");
  const keptEntries = state.entriesBySession[key] ?? [];
  const waitingPrompts = state.waitingPromptsBySession[key] ?? [];
  return {
    ...state,
    entriesBySession: { ...state.entriesBySession, [key]: mergeSessionEntries(keptEntries, message.entries, LIMITS.maxEntriesKept) },
    waitingPromptsBySession: { ...state.waitingPromptsBySession, [key]: savedPrompts.reduce(removeAnsweredPrompt, waitingPrompts) },
  };
};

// The server sends every kept entry again on each new connection.
export const forgetEntries = (state: PageState): PageState => ({ ...state, entriesBySession: {} });

export const addWaitingPrompt = (
  state: PageState,
  machineId: string,
  sessionName: string,
  text: string,
  imagePreviewUrls: string[],
): PageState => {
  const key = sessionKey(machineId, sessionName);
  const waitingPrompt = { text: text.trim(), imagePreviewUrls };
  const waitingPrompts = [...(state.waitingPromptsBySession[key] ?? []), waitingPrompt];
  return { ...state, waitingPromptsBySession: { ...state.waitingPromptsBySession, [key]: waitingPrompts } };
};
