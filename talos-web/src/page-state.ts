import { LIMITS, mergeSessionEntries, type MachineSummary, type SentImage, type ServerToPage, type SessionEntry } from "talos-shared";
import { removeAnsweredPrompt, sessionKey, type WaitingPrompt } from "@/session-rows";

export type ReturnedMessage = { text: string; images: SentImage[] };

export type PageState = {
  machines: MachineSummary[] | null;
  roundTripMsByMachineId: Record<string, number>;
  entriesBySession: Record<string, SessionEntry[]>;
  waitingPromptsBySession: Record<string, WaitingPrompt[]>;
  // Messages that waited and won't go in (after an interrupt),
  // back for the session's message box: their text, and the images this page
  // sent with them.
  returnedBySession: Record<string, ReturnedMessage>;
  notice: string | null;
};

export const EMPTY_PAGE_STATE: PageState = {
  machines: null,
  roundTripMsByMachineId: {},
  entriesBySession: {},
  waitingPromptsBySession: {},
  returnedBySession: {},
  notice: null,
};

// A session that's gone takes its entries with it, as on the server, so a new
// one started under its name doesn't sort among the old one's. An offline
// machine's sessions aren't known, so theirs are kept.
const isStillThere = (machines: readonly MachineSummary[]) => {
  const keys = new Set(machines.flatMap(({ machineId, sessions }) => (sessions ?? []).map(({ sessionName }) => sessionKey(machineId, sessionName))));
  const offline = machines.filter(({ sessions }) => sessions === null).map(({ machineId }) => `${machineId}:`);
  return (key: string) => keys.has(key) || offline.some((prefix) => key.startsWith(prefix));
};
const keptWhere = <Value>(byKey: Record<string, Value>, isKept: (key: string) => boolean): Record<string, Value> =>
  Object.fromEntries(Object.entries(byKey).filter(([key]) => isKept(key)));

// A send that was turned down won't be saved, so its waiting copy goes.
const withoutRefusedPrompt = (state: PageState, requestId: string | undefined): PageState =>
  requestId === undefined
    ? state
    : {
        ...state,
        waitingPromptsBySession: Object.fromEntries(
          Object.entries(state.waitingPromptsBySession).map(([key, prompts]) => [key, prompts.filter((prompt) => prompt.requestId !== requestId)]),
        ),
      };

export const applyServerMessage = (state: PageState, message: ServerToPage): PageState => {
  if (message.type === "machines") {
    const isKept = isStillThere(message.machines);
    return {
      ...state,
      machines: message.machines,
      entriesBySession: keptWhere(state.entriesBySession, isKept),
      waitingPromptsBySession: keptWhere(state.waitingPromptsBySession, isKept),
    };
  }
  if (message.type === "error") return { ...withoutRefusedPrompt(state, message.requestId), notice: message.message };
  if (message.type === "message-returned") {
    const key = sessionKey(message.machineId, message.sessionName);
    const own = message.requestId ? state.waitingPromptsBySession[key]?.find(({ requestId }) => requestId === message.requestId) : undefined;
    const kept = state.returnedBySession[key];
    const returned = {
      text: kept ? `${kept.text}\n\n${message.text}` : message.text,
      images: [...(kept?.images ?? []), ...(own?.sentImages ?? [])].slice(0, LIMITS.maxImagesPerMessage),
    };
    return { ...withoutRefusedPrompt(state, message.requestId), returnedBySession: { ...state.returnedBySession, [key]: returned } };
  }
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

// Once the message box has taken it.
export const forgetReturned = (state: PageState, key: string): PageState => {
  const { [key]: _taken, ...rest } = state.returnedBySession;
  return { ...state, returnedBySession: rest };
};

// The server sends every kept entry again on each new connection.
export const forgetEntries = (state: PageState): PageState => ({ ...state, entriesBySession: {} });

export const addWaitingPrompt = (
  state: PageState,
  machineId: string,
  sessionName: string,
  text: string,
  imagePreviewUrls: string[],
  requestId?: string,
  sentImages: SentImage[] = [],
): PageState => {
  const key = sessionKey(machineId, sessionName);
  const waitingPrompt = { text: text.trim(), imagePreviewUrls, ...(requestId && { requestId }), ...(sentImages.length > 0 && { sentImages }) };
  const waitingPrompts = [...(state.waitingPromptsBySession[key] ?? []), waitingPrompt];
  return { ...state, waitingPromptsBySession: { ...state.waitingPromptsBySession, [key]: waitingPrompts } };
};

// The image previews a change let go of (their message was saved, or its
// session ended): each holds an image in the browser until it's freed.
const previewUrlsOf = (state: PageState): string[] =>
  Object.values(state.waitingPromptsBySession).flatMap((prompts) => prompts.flatMap(({ imagePreviewUrls }) => imagePreviewUrls));
export const droppedPreviewUrls = (before: PageState, after: PageState): string[] => {
  const kept = new Set(previewUrlsOf(after));
  return previewUrlsOf(before).filter((url) => !kept.has(url));
};
