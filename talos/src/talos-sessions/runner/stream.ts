// Following a session's stream: each line Claude Code writes changes the
// session (see stream/stream-lines.ts for what a line can be).
import { COPIED_LIMITS, SESSION_LIMITS } from "../limits";
import { readStreamLine, type StreamEvent } from "../stream/stream-lines";
import { addConversation } from "./conversation";
import { log } from "./inputs";
import { applyOutputsEvent, setSessionState } from "./session-state";
import { broadcastSessions, heldSessions, updateHeldSession, type HeldSession, type WaitingPermission } from "./store";

// The control request a session's start is, answered once Claude Code is ready.
export const START_REQUEST_ID = "talos-start";

// What a tool call would do, in a line, for the page to ask about: its
// command, its file or its address.
const SUMMARY_FIELDS = ["command", "file_path", "path", "url", "pattern", "description", "prompt"];
export const summaryOf = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const telling = SUMMARY_FIELDS.map((field) => Reflect.get(input, field)).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return (telling ?? "").replace(/\s+/g, " ").trim().slice(0, COPIED_LIMITS.maxToolSummaryLength);
};

export const showPermissionAsks = (sessionName: string, session: HeldSession, waitingPermissions: WaitingPermission[]): void => {
  const { permissionAsks: _shown, ...summary } = session.summary;
  const permissionAsks = waitingPermissions.map(({ toolUseId, tool, summary: what }) => ({ id: toolUseId, tool: tool.slice(0, COPIED_LIMITS.maxNameTextLength), summary: what }));
  heldSessions.set(sessionName, { ...session, waitingPermissions, summary: permissionAsks.length > 0 ? { ...summary, permissionAsks } : summary });
  broadcastSessions();
};

// A turn that ended on an open question waits for the person. One talos
// interrupted doesn't close a question: it's still worth answering.
const endTurn = (sessionName: string, session: HeldSession, isError: boolean): void => {
  if (!(isError && session.isInterrupting)) applyOutputsEvent(sessionName, { type: "turn-ended" });
  const current = heldSessions.get(sessionName);
  if (!current) return;
  const { isSelfStarted: _ended, ...summary } = current.summary;
  heldSessions.set(sessionName, { ...current, isInterrupting: false, summary });
  showPermissionAsks(sessionName, heldSessions.get(sessionName)!, []);
  setSessionState(sessionName, current.summary.openOutputs.length > 0 ? "needs-you" : "idle", true);
};

// Conversation while no turn of talos's runs is one Claude Code started on its
// own (a background task's notice): it's working until that turn's result.
const startSelfTurn = (sessionName: string, session: HeldSession): void => {
  updateHeldSession(sessionName, session.heldId, { summary: { ...session.summary, isSelfStarted: true } });
  setSessionState(sessionName, "working", false);
};

const applyStreamEvent = (sessionName: string, session: HeldSession, event: StreamEvent): void => {
  // Also after a slow start was shown as stuck (the answer comes once), but
  // not over a turn Claude Code began on its own as it started.
  const isTurnUnderWay = session.waitingPermissions.length > 0 || session.summary.isSelfStarted === true;
  if (event.type === "control-answer" && event.requestId === START_REQUEST_ID && !isTurnUnderWay) {
    setSessionState(sessionName, event.isOk ? "idle" : "needs-you", event.isOk);
  }
  if (event.type === "conversation") {
    if (session.isTurnOver && session.summary.state !== "starting") startSelfTurn(sessionName, session);
    addConversation(sessionName, event.items);
  }
  if (event.type === "turn-over") endTurn(sessionName, session, event.isError);
  if (event.type === "permission-ask") {
    const { requestId, toolUseId, tool, input } = event;
    showPermissionAsks(sessionName, session, [...session.waitingPermissions, { requestId, toolUseId, tool, input, summary: summaryOf(input) }]);
    setSessionState(sessionName, "needs-you", false);
  }
  if (event.type === "permission-cancel") {
    const waiting = session.waitingPermissions.filter(({ requestId }) => requestId !== event.requestId);
    showPermissionAsks(sessionName, session, waiting);
    if (waiting.length === 0 && !session.isTurnOver) setSessionState(sessionName, "working", false);
  }
};

// Reads the stream a line at a time. A line too long to be one Claude Code
// writes is dropped whole, so one can't make the runner hold an endless line.
export const followStream = async (sessionName: string, heldId: string, stdout: ReadableStream<Uint8Array>): Promise<void> => {
  const decoder = new TextDecoder();
  let unread = "";
  for await (const chunk of stdout) {
    const lines = (unread + decoder.decode(chunk, { stream: true })).split("\n");
    unread = lines.pop() ?? "";
    if (unread.length > SESSION_LIMITS.maxStreamLineBytes) {
      log.warn(`runner: dropped a line from ${sessionName}'s stream past ${SESSION_LIMITS.maxStreamLineBytes} bytes`);
      unread = "";
    }
    for (const line of lines.filter((text) => text.trim())) {
      const session = heldSessions.get(sessionName);
      if (session?.heldId !== heldId) return;
      const event = readStreamLine(line);
      // One line that can't be applied mustn't stop the rest being read.
      try {
        if (event) applyStreamEvent(sessionName, session, event);
      } catch (error) {
        log.warn(`runner: couldn't apply a line from ${sessionName}'s stream: ${error}`);
      }
    }
  }
};

// What Claude Code says outside its stream goes to the runner's log, a line at a time.
export const followErrors = async (sessionName: string, stderr: ReadableStream<Uint8Array>): Promise<void> => {
  for await (const chunk of stderr) log.detail(`runner: ${sessionName} says: ${new TextDecoder().decode(chunk).trim().slice(0, 500)}`);
};
