// What a session's mod and the session runner say over the link. The mod keeps
// its own copy of the names here (it can't import talos-sessions); a test
// fails if the copies drift (link-protocol.test.ts).
import { SESSION_LIMITS } from "../limits";

export const LINK_ROUTES = { checkIn: "/check-in", facts: "/facts", commands: "/commands" } as const;

// Set in the session's env. The token is good for one check-in; the mod
// unsets it, and swaps it for the secret, which it hands only to its helper.
export const LINK_ENV_KEYS = {
  socket: "TALOS_LINK_SOCKET",
  token: "TALOS_LINK_TOKEN",
  bun: "TALOS_BUN",
  secret: "TALOS_LINK_SECRET",
} as const;

export const FACT_TYPES = [
  "session-start",
  "session-end",
  "session-stop",
  "turn-start",
  "turn-complete",
  "prompt-submit",
  "permission-asked",
  "permission-settled",
  "submit-done",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export type CheckIn = { token: string; sessionId: string; version: string; snapshot: string };
// seq counts from 1 within one check-in. Each type's fields ride in details,
// and fact-state.ts reads the ones it needs.
export type Fact = { seq: number; type: FactType; atMs: number; sessionId: string; details: Record<string, unknown> };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isShortText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= SESSION_LIMITS.maxIdTextLength;
const isFactType = (value: unknown): value is FactType => FACT_TYPES.some((type) => type === value);

export const readCheckIn = (body: unknown): CheckIn | null => {
  if (!isPlainObject(body)) return null;
  const { token, sessionId, version, snapshot } = body;
  const isCheckIn = isShortText(token) && isShortText(sessionId) && isShortText(version) && isShortText(snapshot);
  return isCheckIn ? { token, sessionId, version, snapshot } : null;
};

const readFact = (item: unknown): Fact | null => {
  if (!isPlainObject(item)) return null;
  const { seq, type, atMs, sessionId, details } = item;
  const isFact = Number.isSafeInteger(seq) && Number(seq) > 0 && isFactType(type) && typeof atMs === "number" && isShortText(sessionId);
  return isFact ? { seq: Number(seq), type, atMs, sessionId, details: isPlainObject(details) ? details : {} } : null;
};

// A post with one bad fact is turned down whole: the mod resends from the
// last one acked, so a gap must not be skipped over.
export const readFacts = (body: unknown): Fact[] | null => {
  const items = isPlainObject(body) ? body.facts : null;
  if (!Array.isArray(items) || items.length > SESSION_LIMITS.maxFactsPerPost) return null;
  const facts = items.map(readFact);
  return facts.every((fact) => fact !== null) ? (facts as Fact[]) : null;
};

// The facts that come next after lastSeq, in order, stopping at a gap, and
// the new last seq to ack. A fact already taken (a resend) is skipped; one past
// a gap waits for its resend.
export const takeNextFacts = (lastSeq: number, facts: readonly Fact[]): { taken: Fact[]; lastSeq: number } => {
  const bySeq = new Map(facts.map((fact) => [fact.seq, fact]));
  const takeFrom = (seq: number, taken: Fact[]): Fact[] => {
    const fact = bySeq.get(seq);
    return fact ? takeFrom(seq + 1, [...taken, fact]) : taken;
  };
  const taken = takeFrom(lastSeq + 1, []);
  return { taken, lastSeq: lastSeq + taken.length };
};

// Who started a turn: the person (at the terminal or through Remote Control),
// talos (through the mod), or Claude Code on its own (a sub-agent's turn, a
// background task's notice, a wake-up).
export const TURN_STARTERS = ["person", "talos", "self"] as const;
export type TurnStarter = (typeof TURN_STARTERS)[number];

export type FactsAnswer = { acked: number };
export type CheckInAnswer = { secret: string };
// One line per command on the helper's stream. A submit goes in as the
// person's own words (isPerson: what they typed on the page) or framed as the
// talos mod's (an ask, an answer); the mod reports its outcome as a
// submit-done fact with the same sendId.
// An abort stops the running turn, as Esc would, but leaves the session able
// to take sends.
export type LinkCommand = { type: "heartbeat" } | { type: "submit"; sendId: string; text: string; isPerson: boolean } | { type: "abort" };
export const encodeLinkCommand = (command: LinkCommand): string => `${JSON.stringify(command)}\n`;
