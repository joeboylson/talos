import { LIMITS, openDecisionOf, statusOf, type MachineSummary, type SessionDecision, type SessionEntry, type SessionState, type SessionStatus } from "talos-shared";

export type SessionRow = {
  machineId: string;
  machineName: string;
  sessionName: string;
  folderName: string;
  state: SessionState;
  status?: SessionStatus;
  decision?: SessionDecision;
  // Claude Code asks permission in its terminal (needs you, mid-turn): only
  // the terminal can answer it.
  isPromptShowing: boolean;
};

export const sessionKey = (machineId: string, sessionName: string): string => `${machineId}:${sessionName}`;

// Every session on the person's connected machines, by machine then session.
export const buildSessionRows = (machines: MachineSummary[]): SessionRow[] =>
  machines
    .flatMap(({ machineId, machineName, sessions }) =>
      (sessions ?? []).map((session) => {
        const status = statusOf(session);
        const decision = openDecisionOf(session);
        const { sessionName, folderName, state } = session;
        const isPromptShowing = state === "needs-you" && session.isTurnOver === false;
        return { machineId, machineName, sessionName, folderName, state, isPromptShowing, ...(status && { status }), ...(decision && { decision }) };
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
export type WaitingPrompt = { text: string; imagePreviewUrls: string[]; requestId?: string };

// The first waiting message with the same text and number of images is the
// one Claude Code just saved.
export const removeAnsweredPrompt = (
  waitingPrompts: WaitingPrompt[],
  answeredPrompt: Extract<SessionEntry, { kind: "prompt" }>,
): WaitingPrompt[] => {
  // A saved prompt is cut to the kept length, so a long message matches by its start.
  const answeredIndex = waitingPrompts.findIndex(
    ({ text, imagePreviewUrls }) =>
      text.slice(0, LIMITS.maxEntryTextLength) === answeredPrompt.text.trim() && imagePreviewUrls.length === answeredPrompt.imageCount,
  );
  return answeredIndex === -1 ? waitingPrompts : waitingPrompts.filter((_, index) => index !== answeredIndex);
};
