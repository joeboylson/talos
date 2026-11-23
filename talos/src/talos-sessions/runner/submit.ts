// Sending text into a session through its mod (see LinkCommand in
// link-protocol.ts): nothing is typed into its terminal.
import { encodeLinkCommand } from "../link/link-protocol";
import type { HeldSession } from "./store";

// The send's id, or null when there's no link to send through: the mod hasn't
// checked in, or it's gone. The mod reports how it went as a submit-done fact.
export const submitThroughMod = (session: HeldSession, text: string, isPerson: boolean): string | null => {
  const { commands } = session.link;
  if (!commands || session.summary.link !== "linked") return null;
  const sendId = crypto.randomUUID();
  try {
    commands.enqueue(encodeLinkCommand({ type: "submit", sendId, text, isPerson }));
    return sendId;
  } catch {
    return null;
  }
};
