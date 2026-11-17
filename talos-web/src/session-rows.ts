import type { MachineSummary, SessionState } from "talos-shared";

export type SessionRow = {
  machineId: string;
  machineName: string;
  sessionName: string;
  folderName: string;
  state: SessionState;
};

export const sessionKey = (machineId: string, sessionName: string): string => `${machineId}:${sessionName}`;

// Every session on the person's connected machines, by machine then session.
export const buildSessionRows = (machines: MachineSummary[]): SessionRow[] =>
  machines
    .flatMap(({ machineId, machineName, sessions }) =>
      (sessions ?? []).map(({ sessionName, folderName, state }) => ({ machineId, machineName, sessionName, folderName, state })),
    )
    .sort(
      (first, second) =>
        first.machineName.localeCompare(second.machineName) || first.sessionName.localeCompare(second.sessionName),
    );

export const findSessionRow = (machines: MachineSummary[], machineName: string, sessionName: string): SessionRow | null =>
  buildSessionRows(machines).find((row) => row.machineName === machineName && row.sessionName === sessionName) ?? null;

// A message sent from the page shows as waiting until its exchange comes
// back. The first waiting message that matches the finished prompt is done.
export const removeAnsweredPrompt = (waitingPrompts: string[], answeredPrompt: string): string[] => {
  const answeredIndex = waitingPrompts.indexOf(answeredPrompt.trim());
  return answeredIndex === -1 ? waitingPrompts : waitingPrompts.filter((_, index) => index !== answeredIndex);
};
