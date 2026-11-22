// Every cap the server keeps for itself, in one place. Limits both sides check
// live in talos-shared's LIMITS.
import { MINUTE_MS } from "./constants";

export const SERVER_LIMITS = {
  // Every HTTP request here is small JSON.
  maxRequestBodyBytes: 64 * 1024,
  minSessionSecretLength: 32,
  // A machine's session/folder updates are coalesced per owner into one page
  // broadcast per this window, so a burst (or a flood) can't amplify.
  machineListRelayCoalesceMs: 100,
  // Requests sent on to machines, remembered so a refusal goes back to the page
  // that asked; past this the oldest are forgotten (their refusal goes to all
  // the owner's pages instead).
  maxPendingRequests: 1000,
  // What may wait for one backed-up page socket before it's closed. A page
  // opening gets every kept history, a few hundred KB a session.
  // shortcut: a person with more kept history than this (about 150 full
  // sessions) gets a page that's closed while it opens, again and again; send
  // history on demand, or raise this, before anyone has that many.
  maxWaitingPageBytes: 64 * 1024 * 1024,
  // Starting a pairing needs no sign-in, so cap how many can wait at once.
  maxWaitingPairings: 100,
  // How often one address may start a pairing, and one person enter a code.
  // Plenty for real use; too few to fill the queue or guess codes.
  pairStart: { windowMs: 10 * MINUTE_MS, maxAttempts: 10 },
  pairApprove: { windowMs: 10 * MINUTE_MS, maxAttempts: 10 },
  maxMachinesPerPerson: 20,
  // Machines send a few messages per session per second; this is well above that.
  maxSocketMessagesPerWindow: 1000,
  // Waiting pairings one address may hold, so a few addresses can't fill the
  // server's whole queue and lock pairing for everyone.
  maxWaitingPairingsPerAddress: 2,
  maxMachineNameLength: 64,
  // A started session's name stays taken this long while the machine hasn't
  // reported it yet, and no more than this many wait per machine.
  startedNameWaitMs: 30_000,
  maxStartingSessions: 100,
} as const;
