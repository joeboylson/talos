// Messages from the page: each waits its turn, then goes in with its images.
import type { SentImage } from "../shapes";
import { removeControlCharacters } from "../clean";
import { noSuchSession, refuse } from "./refuse";
import { SESSION_LIMITS } from "../limits";
import { sendWhenSettled } from "./session-state";
import { broadcast, broadcastSessions, heldSessions, type HeldSession, type WaitingMessage } from "./store";

// Every message waits its turn in the session's list and goes in once the
// turn is over (see sendWhenSettled): one written mid-turn would join the
// turn that's running, and an interrupt gives the waiting ones back to the page.
export const sendToSession = (sessionName: string, text: string, images: SentImage[], requestId?: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  if (session.queuedMessages.length >= SESSION_LIMITS.maxQueuedMessages) return refuse("too-many-waiting", "It has as many messages waiting as it takes");
  setWaitingMessages(sessionName, session, [...session.queuedMessages, { text: removeControlCharacters(text).trim(), images, ...(requestId && { requestId }) }]);
  sendWhenSettled(sessionName);
  return new Response(null, { status: 204 });
};

// The session list shows what waits, so every page sees it.
export const setWaitingMessages = (sessionName: string, session: HeldSession, queuedMessages: WaitingMessage[]): void => {
  const { waitingMessages: _shown, ...summary } = session.summary;
  const waitingMessages = queuedMessages.map(({ text }) => text);
  heldSessions.set(sessionName, { ...session, queuedMessages, summary: waitingMessages.length > 0 ? { ...summary, waitingMessages } : summary });
  broadcastSessions();
};

// What waited won't go in (an interrupt): each message goes back to the page
// that sent it, for its message box.
export const giveBackWaitingMessages = (sessionName: string): void => {
  const session = heldSessions.get(sessionName);
  if (!session || session.queuedMessages.length === 0) return;
  session.queuedMessages.forEach(({ text, requestId }) => broadcast({ type: "message-returned", sessionName, text, ...(requestId && { requestId }) }));
  setWaitingMessages(sessionName, session, []);
};

// Its mod is gone, so talos's tools and its asks can't work.
export const refuseLinkLost = (): Response => refuse("link-lost", "talos lost touch with its mod");
