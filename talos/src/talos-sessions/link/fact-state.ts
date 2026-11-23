// A session's state, worked out from its mod's facts alone: one rule per fact.
// See docs/GLOSSARY.md for the states.
import type { SessionState } from "../shapes";
import { TURN_STARTERS, type Fact, type TurnStarter } from "./link-protocol";

export type FactView = {
  activity: Exclude<SessionState, "needs-you">;
  isTurnOver: boolean;
  // Esc during a turn. Claude Code refuses the mod's sends until the person
  // enters something at the terminal (or through Remote Control).
  isStopped: boolean;
  // Permission prompts showing, by tool call id; a sub-agent's shows in the
  // same terminal.
  waitingPermissions: readonly string[];
  turnStarter: TurnStarter | null;
};

export const NO_FACTS: FactView = { activity: "starting", isTurnOver: true, isStopped: false, waitingPermissions: [], turnStarter: null };

const textOf = (details: Record<string, unknown>, field: string): string | null => {
  const value = details[field];
  return typeof value === "string" ? value : null;
};
// A sub-agent's turns aren't the session's: they start and end inside it.
const isMainLoop = (fact: Fact): boolean => fact.details.agentId === undefined;
const starterOf = (fact: Fact): TurnStarter => TURN_STARTERS.find((starter) => starter === fact.details.startedBy) ?? "self";
const isFromPerson = (fact: Fact): boolean => {
  const origin = fact.details.origin;
  const kind = typeof origin === "object" && origin !== null ? Reflect.get(origin, "kind") : undefined;
  return kind === "composer" || kind === "bridge";
};

export const stepFactView = (view: FactView, fact: Fact): FactView => {
  const toolUseId = textOf(fact.details, "toolUseId");
  switch (fact.type) {
    case "session-start":
      return view.activity === "starting" ? { ...view, activity: "idle" } : view;
    // Continuing a stopped session starts the person's turn: it counts as
    // under way from here, so nothing talos holds is typed in ahead of it.
    case "prompt-submit":
      if (!isFromPerson(fact)) return view;
      return view.isStopped ? { ...view, isStopped: false, activity: "working", isTurnOver: false } : view;
    // A stop with no turn running (Remote Control's Stop at idle) stops
    // nothing that was under way; only Esc mid-turn was seen to refuse sends.
    case "session-stop":
      return fact.details.isTurnRunning === true ? { ...view, isStopped: true } : view;
    case "turn-start":
      return isMainLoop(fact) ? { ...view, activity: "working", isTurnOver: false, turnStarter: starterOf(fact) } : view;
    case "turn-complete":
      return isMainLoop(fact) ? { ...view, activity: "idle", isTurnOver: true, waitingPermissions: [], turnStarter: null } : view;
    case "permission-asked":
      return toolUseId && !view.waitingPermissions.includes(toolUseId) ? { ...view, waitingPermissions: [...view.waitingPermissions, toolUseId] } : view;
    case "permission-settled":
      return { ...view, waitingPermissions: view.waitingPermissions.filter((id) => id !== toolUseId) };
    case "session-end":
      return view;
  }
};

// What the page would show. A permission prompt comes first: it waits on the
// person whatever else holds. "stopped" shows only once the turn is over.
export type ShownState = SessionState | "stopped";
export const shownFactState = (view: FactView): ShownState => {
  if (view.waitingPermissions.length > 0) return "needs-you";
  if (view.isStopped && view.isTurnOver) return "stopped";
  return view.activity;
};
