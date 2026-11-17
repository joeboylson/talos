// Pairing gives a new machine its own key. The machine asks for a short code,
// Joe types that code into the page while signed in, and the machine collects
// its key on its next poll.

export type PairStartRequest = { machineName: string };
export type PairStartResponse = { pairingId: string; userCode: string; expiresAtMs: number };

export type PairPollRequest = { pairingId: string };
export type PairPollResponse =
  | { status: "waiting" }
  | { status: "approved"; machineKey: string; machineName: string }
  | { status: "expired" };

export type PairApproveRequest = { userCode: string };
export type PairApproveResponse = { machineName: string };

export const PAIR_POLL_INTERVAL_MS = 3000;
