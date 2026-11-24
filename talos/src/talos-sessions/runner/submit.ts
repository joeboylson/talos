// What talos writes to a session: lines on Claude Code's input stream.
import type { SentImage } from "../shapes";
import { userMessageLine } from "../stream/stream-lines";
import type { HeldSession } from "./store";

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
