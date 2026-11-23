// Sending to a session through its mod (see LinkCommand in link-protocol.ts):
// nothing is typed into its terminal.
import { encodeLinkCommand, type LinkCommand } from "../link/link-protocol";
import type { HeldSession } from "./store";

// False when there's no link to send through: the mod hasn't checked in, or
// its helper is gone (the write to it throws).
export const sendCommand = (session: HeldSession, command: LinkCommand): boolean => {
  const { commands } = session.link;
  if (!commands || session.summary.link !== "linked") return false;
  try {
    commands.enqueue(encodeLinkCommand(command));
    return true;
  } catch {
    return false;
  }
};

// The send's id, or null when there's no link. The mod reports how it went as
// a submit-done fact.
export const submitThroughMod = (session: HeldSession, text: string, isPerson: boolean): string | null => {
  const sendId = crypto.randomUUID();
  return sendCommand(session, { type: "submit", sendId, text, isPerson }) ? sendId : null;
};
