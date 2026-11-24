// What talos writes to a session: lines on Claude Code's input stream, and
// commands to its mod (see LinkCommand in link-protocol.ts).
import { encodeLinkCommand, type LinkCommand } from "../link/link-protocol";
import type { SentImage } from "../shapes";
import { userMessageLine } from "../stream/stream-lines";
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

// False once Claude Code has closed its input (it's ending).
export const writeLine = (session: HeldSession, line: string): boolean => {
  try {
    session.child.stdin.write(line);
    session.child.stdin.flush();
    return true;
  } catch {
    return false;
  }
};

export const writeMessage = (session: HeldSession, text: string, images: readonly SentImage[] = []): boolean => writeLine(session, userMessageLine(text, images));
