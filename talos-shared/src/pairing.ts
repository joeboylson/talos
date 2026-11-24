// Pairing gives a new machine its own key. The machine asks for a short code,
// its owner types that code into the page while signed in, the machine shows
// who approved it and its owner confirms there, and only then does the
// machine collect its key. Someone else who saw the code and typed it first
// is caught at the machine, before any key exists.

export type PairStartRequest = { machineName: string };
export type PairStartResponse = { pairingId: string; userCode: string; expiresAtMs: number };

export type PairPollRequest = { pairingId: string };
export type PairPollResponse =
  | { status: "waiting" }
  | { status: "approved"; approvedBy: string }
  | { status: "expired" };

export type PairCollectRequest = { pairingId: string };
export type PairCollectResponse = { machineKey: string; machineName: string };

export type PairApproveRequest = { userCode: string };
export type PairApproveResponse = { machineName: string };

export const PAIR_POLL_INTERVAL_MS = 3000;

// A pairing link (talos prints it) opens the Machines page with the pairing
// dialog open and this parameter's code filled in.
export const PAIR_CODE_PARAMETER = "pair";
