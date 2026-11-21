import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { hostname } from "node:os";
import {
  ENV_KEYS,
  LIMITS,
  RECONNECT_DELAY_MS,
  batchEntriesBySize,
  createLogger,
  httpOriginFromServerUrl,
  isSafeServerUrl,
  mergeSessionEntries,
  readLogsMode,
  requireEnv,
  toIdentifierName,
  WS_CLOSE_CODES,
  type ServerToMachine,
  type SessionEntry,
  type SessionSummary,
} from "talos-shared";
import { CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE, FOLDERS_FILE, RUNNER_SCRIPT, TALOS_FOLDER } from "./constants";
import { forgetCredentials, readCredentials, saveCredentials } from "./credentials";
import { readFolders, renameFolder, saveFolders } from "./folders";
import { connectToSessions, type Result } from "./talos-sessions";
import { toSharedEvent, type SharedRunnerEvent } from "./session-bridge";
import { startLocalStatusServer } from "./local-status-server";
import { fetchMachineName, pairMachine } from "./pairing";
import { connectToServer, type SendToServer } from "./server-connection";
import { TALOS_LIMITS } from "./limits";

// `talos` with no command: pair this machine if it isn't yet, connect to the
// server, and stay connected.
export const runConnect = async (): Promise<void> => {
  const serverUrl = requireEnv(ENV_KEYS.serverUrl);
  if (!isSafeServerUrl(serverUrl)) {
    throw new Error(`${ENV_KEYS.serverUrl} must start with wss:// (ws:// only works for a server on this computer)`);
  }
  const serverOrigin = httpOriginFromServerUrl(serverUrl);
  const wantedMachineName = toIdentifierName(process.env[ENV_KEYS.machineName] || hostname());
  const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));
  const sessions = connectToSessions({ home: TALOS_FOLDER, runnerScript: RUNNER_SCRIPT });

  // What talos changes as it runs: whether it's connected, the name the server
  // gave it, how to reach the server while connected, and the latest sessions
  // and entries, sent again whenever it reconnects.
  let isConnected = false;
  let machineName = wantedMachineName;
  let sendToServer: SendToServer | null = null;
  let latestSessions: SessionSummary[] = [];
  let entriesBySession: Record<string, SessionEntry[]> = {};
  // Sessions whose kept entries haven't been sent again since this connection
  // opened. Their live entries wait (they're kept above) and go out with their
  // turn, so the page never gets newer entries before older ones.
  let sessionsAwaitingResend = new Set<string>();

  const keepLatest = (runnerEvent: Exclude<SharedRunnerEvent, { type: "notice" }>) => {
    if (runnerEvent.type === "sessions") {
      latestSessions = runnerEvent.sessions;
      const liveSessionNames = new Set(latestSessions.map(({ sessionName }) => sessionName));
      entriesBySession = Object.fromEntries(
        Object.entries(entriesBySession).filter(([sessionName]) => liveSessionNames.has(sessionName)),
      );
      return;
    }
    const keptEntries = entriesBySession[runnerEvent.sessionName] ?? [];
    const mergedEntries = mergeSessionEntries(keptEntries, runnerEvent.entries, LIMITS.maxEntriesKept);
    entriesBySession = { ...entriesBySession, [runnerEvent.sessionName]: mergedEntries };
  };

  // Sends one session's kept entries again, in batches under the server's
  // message limit and paced under its byte budget. Entries that arrive or change
  // during a pause go out in the next round (an unchanged entry keeps its object,
  // so the rest aren't sent twice). The session stays held until nothing is left,
  // then leaves the held set at once, so a live entry can't overtake an older
  // batch. Returns false if the connection changed.
  const resendSessionEntries = async (sessionName: string, send: SendToServer): Promise<boolean> => {
    const sentEntries = new Set<SessionEntry>();
    while (true) {
      const unsentEntries = (entriesBySession[sessionName] ?? []).filter((entry) => !sentEntries.has(entry));
      if (unsentEntries.length === 0) return true;
      for (const batch of batchEntriesBySize(unsentEntries, LIMITS.maxEntriesBatchBytes)) {
        if (sendToServer !== send) return false;
        send({ type: "session-entries", sessionName, entries: batch.entries });
        batch.entries.forEach((entry) => sentEntries.add(entry));
        await Bun.sleep(batch.byteCount / TALOS_LIMITS.resendBytesPerMs);
      }
    }
  };

  // A bigger message closes the socket, and the same resend on every reconnect
  // would close it again; too much at once and the server drops it unread.
  // shortcut: live entries from sessions already resent aren't paced, so a heavy
  // burst during a resend can still push a batch past the server's budget; pace
  // all uplink traffic if that shows up.
  const sendLatest = async (send: SendToServer) => {
    send({ type: "sessions", sessions: latestSessions });
    sessionsAwaitingResend = new Set(Object.keys(entriesBySession));
    for (const sessionName of [...sessionsAwaitingResend]) {
      const isStillThisConnection = await resendSessionEntries(sessionName, send);
      if (!isStillThisConnection) return;
      sessionsAwaitingResend.delete(sessionName);
    }
  };

  const sendFolders = async () => {
    if (!sendToServer) return;
    const folders = await readFolders();
    sendToServer({ type: "folders", folders });
    log.detail(`talos: told the server about ${folders.length} folder(s)`);
  };

  // A failed folder read or send is logged, not thrown: Bun quits on an
  // unhandled rejection, which would take this machine offline.
  const sendFoldersOrWarn = () => void sendFolders().catch((error: unknown) => log.warn(`talos: couldn't send the folders (${error})`));

  const forwardRunnerEvent = (runnerEvent: SharedRunnerEvent) => {
    if (runnerEvent.type === "notice") {
      return sendToServer?.({ type: "error", message: `${runnerEvent.sessionName}: ${runnerEvent.message}`.slice(0, LIMITS.maxMachineErrorLength) });
    }
    keepLatest(runnerEvent);
    if (!sendToServer) return;
    if (runnerEvent.type === "sessions") return sendToServer({ type: "sessions", sessions: runnerEvent.sessions });
    if (sessionsAwaitingResend.has(runnerEvent.sessionName)) return;
    batchEntriesBySize(runnerEvent.entries, LIMITS.maxEntriesBatchBytes).forEach((batch) =>
      sendToServer?.({ type: "session-entries", sessionName: runnerEvent.sessionName, entries: batch.entries }),
    );
  };

  // Sessions run in the session runner, which outlives talos. If the session runner goes
  // away (`talos runner stop`), a fresh one is started.
  // The page is told which sessions ended with the runner, since they and
  // anything waiting in them go without a word otherwise.
  const forgetRunnerSessions = () => {
    const ended = latestSessions.map(({ sessionName }) => sessionName);
    if (ended.length > 0) tellPage(`The session runner stopped; ended ${ended.join(", ")}`);
    forwardRunnerEvent({ type: "sessions", sessions: [] });
  };
  const followRunner = async (): Promise<void> => {
    await sessions.ensureRunning();
    await sessions.follow((runnerEvent) => forwardRunnerEvent(toSharedEvent(runnerEvent))).ended;
  };
  const followRunnerWithRetry = (): void => {
    followRunner()
      .catch((error: unknown) => log.warn(`talos: lost the session runner (${error})`))
      .finally(() => {
        forgetRunnerSessions();
        setTimeout(followRunnerWithRetry, RECONNECT_DELAY_MS);
      });
  };

  // What the owner tried and couldn't do is shown on their page, so a click
  // never fails silently.
  const tellPage = (problem: string) => sendToServer?.({ type: "error", message: problem.slice(0, LIMITS.maxMachineErrorLength) });
  const reportRefusal = (result: Result) => {
    if (!result.ok) tellPage(result.reason);
  };

  // A session starts only in a folder this machine allows, found by name in
  // its own folder list: the page never sends a path.
  const startSession = async (folderName: string, sessionName: string) => {
    const folder = (await readFolders()).find((candidate) => candidate.folderName === folderName);
    if (!folder) return tellPage(`There's no folder called ${folderName}`);
    reportRefusal(await sessions.start(sessionName, folderName, folder.path));
  };

  // The owner, on the page: renamed this machine or a folder, or started,
  // messaged or stopped a session.
  const handleServerMessage = async (message: Exclude<ServerToMachine, { type: "ping" }>) => {
    if (message.type === "start-session") return startSession(message.folderName, message.sessionName);
    if (message.type === "send-to-session") return reportRefusal(await sessions.send(message.sessionName, message.text, message.images));
    if (message.type === "stop-session") return reportRefusal(await sessions.stop(message.sessionName));
    if (message.type === "ask-for-output") {
      return reportRefusal(await sessions.ask(message.sessionName, message.kind));
    }
    if (message.type === "answer-output") {
      const { sessionName, outputId, choice } = message;
      return reportRefusal(await sessions.answer(sessionName, outputId, choice));
    }
    if (message.type === "machine-name") {
      machineName = message.machineName;
      const savedCredentials = await readCredentials(serverUrl);
      if (savedCredentials) await saveCredentials({ ...savedCredentials, machineName });
      return log.event(`talos: this machine is now called ${machineName}`);
    }
    const change = renameFolder(await readFolders(), message.folderName, message.newFolderName);
    if ("problem" in change) return log.warn(`talos: couldn't rename a folder: ${change.problem}`);
    await saveFolders(change.folders);
    log.event(`talos: folder ${message.folderName} is now called ${change.folder.folderName}`);
  };

  // A saved key the server no longer knows (the machine was removed from the
  // page) is thrown away, and the machine pairs again. The server's name for
  // the machine is saved too, for folder identifiers.
  const getAcceptedMachineKey = async (): Promise<string> => {
    const savedCredentials = await readCredentials(serverUrl);
    const knownMachineName =
      savedCredentials && (await fetchMachineName(serverOrigin, savedCredentials.machineKey, log));
    if (savedCredentials && knownMachineName) {
      machineName = knownMachineName;
      if (savedCredentials.machineName !== knownMachineName) {
        await saveCredentials({ ...savedCredentials, machineName: knownMachineName });
      }
      return savedCredentials.machineKey;
    }
    if (savedCredentials) await forgetCredentials();

    const pairedMachine = await pairMachine(serverOrigin, wantedMachineName, log);
    machineName = pairedMachine.machineName;
    await saveCredentials({ serverUrl, ...pairedMachine });
    return pairedMachine.machineKey;
  };

  // Each connection, and each retry after it drops, starts by checking the key.
  const connect = async (): Promise<void> => {
    const machineKey = await getAcceptedMachineKey();
    connectToServer({
      serverUrl,
      machineKey,
      log,
      // The session runner can be down (restarting, or `talos runner stop`), or
      // answer in a way this talos doesn't know, so a page command can fail; the
      // page is told, and it's logged rather than let Bun quit on the rejection.
      onServerMessage: (message) =>
        void handleServerMessage(message).catch((error: unknown) => {
          log.warn(`talos: couldn't handle ${message.type} from the server (${error})`);
          tellPage("That didn't reach the session runner; try again");
        }),
      onOpen: (send) => {
        sendToServer = send;
        sendFoldersOrWarn();
        void sendLatest(send).catch((error: unknown) => log.warn(`talos: couldn't send the latest entries (${error})`));
      },
      onConnectionChange: (isNowConnected, closeCode) => {
        isConnected = isNowConnected;
        if (isNowConnected) return;
        sendToServer = null;
        // Another talos on this machine connected with its key: reconnecting
        // would replace it, and it would replace this one, back and forth.
        if (closeCode === WS_CLOSE_CODES.machineReplaced) {
          log.warn("talos: another talos on this machine took over; this one stops");
          process.exit(0);
        }
        setTimeout(connectWithRetry, RECONNECT_DELAY_MS);
      },
    });
  };

  // While the server is down, keep trying instead of crashing.
  const connectWithRetry = (): void => {
    connect().catch((error: unknown) => {
      log.event(`talos: can't reach ${serverOrigin} (${error}), retrying in ${RECONNECT_DELAY_MS / 1000}s`);
      setTimeout(connectWithRetry, RECONNECT_DELAY_MS);
    });
  };

  // `talos folders add|remove` edits the folders file from
  // another terminal; this tells the server as soon as it changes.
  await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  watch(CREDENTIALS_FOLDER, (_event, changedFileName) => {
    if (changedFileName === basename(FOLDERS_FILE)) sendFoldersOrWarn();
  });

  startLocalStatusServer({
    allowedOrigin: serverOrigin,
    readLocalStatus: () => ({ machineName, isConnected }),
    log,
  });
  log.event(`talos: starting as ${wantedMachineName}, server ${serverOrigin}`);

  followRunnerWithRetry();
  connectWithRetry();
};
