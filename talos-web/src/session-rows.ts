import { LIMITS, openDecisionOf, statusOf, type LinkState, type PermissionAsk, type SentImage, type MachineSummary, type SessionDecision, type SessionEntry, type SessionState, type SessionStatus } from "talos-shared";

export type SessionRow = {
  machineId: string;
  machineName: string;
  sessionName: string;
  folderName: string;
  state: SessionState;
  status?: SessionStatus;
  decision?: SessionDecision;
  // It needs the person mid-turn: a permission question, or (with none
  // listed) a start that never finished.
  isPromptShowing: boolean;
  link?: LinkState;
  isSelfStarted?: true;
  // Messages waiting for the turn to be over, sent from any page.
  waitingMessages?: string[];
  // Permission questions waiting, answered here.
  permissionAsks?: PermissionAsk[];
};

export const sessionKey = (machineId: string, sessionName: string): string => `${machineId}:${sessionName}`;

// Every session on the person's connected machines, by machine then session.
export const buildSessionRows = (machines: MachineSummary[]): SessionRow[] =>
  machines
    .flatMap(({ machineId, machineName, sessions }) =>
      (sessions ?? []).map((session) => {
        const status = statusOf(session);
        const decision = openDecisionOf(session);
        const { sessionName, folderName, state, link, isSelfStarted, waitingMessages, permissionAsks } = session;
        const isPromptShowing = state === "needs-you" && session.isTurnOver === false;
        return {
          machineId,
          machineName,
          sessionName,
          folderName,
          state,
          isPromptShowing,
          ...(status && { status }),
          ...(decision && { decision }),
          ...(link && { link }),
          ...(isSelfStarted && { isSelfStarted }),
          ...(waitingMessages && { waitingMessages }),
          ...(permissionAsks && { permissionAsks }),
        };
      }),
    )
    .sort(
      (first, second) =>
        first.machineName.localeCompare(second.machineName) || first.sessionName.localeCompare(second.sessionName),
    );

export const findSessionRow = (machines: MachineSummary[], machineName: string, sessionName: string): SessionRow | null =>
  buildSessionRows(machines).find((row) => row.machineName === machineName && row.sessionName === sessionName) ?? null;

// A message sent from the page, with previews of its images, shown as
// waiting until Claude Code saves it.
// requestId: the send's own id, so a refusal of it takes its bubble away.
// sentImages: what was sent, to give back with the text if it's returned.
export type WaitingPrompt = { text: string; imagePreviewUrls: string[]; requestId?: string; sentImages?: SentImage[] };

// A message as the session saves it: without the control characters the
// session runner strips (all but line breaks and tabs; its rule is in
// talos-sessions' clean.ts), and cut to the kept length.
const STRIPPED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const asSaved = (text: string): string => text.replace(STRIPPED_CONTROL_CHARACTERS, "").trim().slice(0, LIMITS.maxEntryTextLength);

// The first waiting message with the same text and number of images is the
// one Claude Code just saved.
export const removeAnsweredPrompt = (
  waitingPrompts: WaitingPrompt[],
  answeredPrompt: Extract<SessionEntry, { kind: "prompt" }>,
): WaitingPrompt[] => {
  const answeredIndex = waitingPrompts.findIndex(
    ({ text, imagePreviewUrls }) => asSaved(text) === answeredPrompt.text.trim() && imagePreviewUrls.length === answeredPrompt.imageCount,
  );
  return answeredIndex === -1 ? waitingPrompts : waitingPrompts.filter((_, index) => index !== answeredIndex);
};

// What other pages left waiting: the session's waiting messages less this
// page's own, matched by text one for one.
export const othersWaiting = (waitingMessages: readonly string[], ownPrompts: readonly WaitingPrompt[]): string[] =>
  waitingMessages.reduce<{ left: string[]; own: string[] }>(
    ({ left, own }, text) => {
      const ownIndex = own.indexOf(asSaved(text));
      return ownIndex === -1 ? { left: [...left, text], own } : { left, own: own.filter((_, index) => index !== ownIndex) };
    },
    { left: [], own: ownPrompts.map(({ text }) => asSaved(text)) },
  ).left;
