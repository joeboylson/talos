import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { hostname } from "node:os";
import {
  ENV_KEYS,
  MAX_ENTRIES_KEPT,
  RECONNECT_DELAY_MS,
  createLogger,
  httpOriginFromServerUrl,
  isSafeServerUrl,
  mergeSessionEntries,
  readLogsMode,
  requireEnv,
  toIdentifierName,
  type ServerToMachine,
  type SessionEntry,
  type SessionSummary,
} from "talos-shared";
import { CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE, FOLDERS_FILE } from "./constants";
import { forgetCredentials, readCredentials, saveCredentials } from "./credentials";
import { readFolders, renameFolder, saveFolders } from "./folders";
import { ensureHostRunning, followHostEvents, postToHost } from "./host-client";
import { HOST_ROUTES, sessionRoute, type HostEvent } from "./host-protocol";
import { startLocalStatusServer } from "./local-status-server";
import { fetchMachineName, pairMachine } from "./pairing";
import { connectToServer, type SendToServer } from "./server-connection";

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

  // What talos changes as it runs: whether it's connected, the name the server
  // gave it, how to reach the server while connected, and the latest sessions
  // and entries, sent again whenever it reconnects.
  let isConnected = false;
  let machineName = wantedMachineName;
  let sendToServer: SendToServer | null = null;
  let latestSessions: SessionSummary[] = [];
  let entriesBySession: Record<string, SessionEntry[]> = {};

  const keepLatest = (hostEvent: HostEvent) => {
    if (hostEvent.type === "sessions") {
      latestSessions = hostEvent.sessions;
      const liveSessionNames = new Set(latestSessions.map(({ sessionName }) => sessionName));
      entriesBySession = Object.fromEntries(
        Object.entries(entriesBySession).filter(([sessionName]) => liveSessionNames.has(sessionName)),
      );
      return;
    }
    const keptEntries = entriesBySession[hostEvent.sessionName] ?? [];
    const mergedEntries = mergeSessionEntries(keptEntries, hostEvent.entries, MAX_ENTRIES_KEPT);
    entriesBySession = { ...entriesBySession, [hostEvent.sessionName]: mergedEntries };
  };

  const sendLatest = (send: SendToServer) => {
    send({ type: "sessions", sessions: latestSessions });
    Object.entries(entriesBySession).forEach(([sessionName, entries]) =>
      send({ type: "session-entries", sessionName, entries }),
    );
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

  const forwardHostEvent = (hostEvent: HostEvent) => {
    keepLatest(hostEvent);
    if (!sendToServer) return;
    if (hostEvent.type === "sessions") return sendToServer({ type: "sessions", sessions: hostEvent.sessions });
    sendToServer({ type: "session-entries", sessionName: hostEvent.sessionName, entries: hostEvent.entries });
  };

  // Sessions run in the session host, which outlives talos. If the host goes
  // away (`talos host stop`), a fresh one is started.
  const followHost = async (): Promise<void> => {
    await ensureHostRunning();
    await followHostEvents(forwardHostEvent);
    forwardHostEvent({ type: "sessions", sessions: [] });
  };
  const followHostWithRetry = (): void => {
    followHost()
      .catch((error: unknown) => log.warn(`talos: lost the session host (${error})`))
      .finally(() => setTimeout(followHostWithRetry, RECONNECT_DELAY_MS));
  };

  // A session starts only in a folder this machine allows, found by name in
  // its own folder list: the page never sends a path.
  const startSession = async (folderName: string, sessionName: string) => {
    const folder = (await readFolders()).find((candidate) => candidate.folderName === folderName);
    if (!folder) return log.warn(`talos: no folder called ${folderName}; not starting ${sessionName}`);
    const response = await postToHost(HOST_ROUTES.sessions, { sessionName, folderName, path: folder.path });
    if (!response.ok) log.warn(`talos: couldn't start ${sessionName}: ${await response.text()}`);
  };

  // The owner, on the page: renamed this machine or a folder, or started,
  // messaged or stopped a session.
  const handleServerMessage = async (message: Exclude<ServerToMachine, { type: "ping" }>) => {
    if (message.type === "start-session") return startSession(message.folderName, message.sessionName);
    if (message.type === "send-to-session") {
      const response = await postToHost(sessionRoute(message.sessionName, "send"), {
        text: message.text,
        images: message.images,
      });
      if (!response.ok) log.warn(`talos: couldn't send to ${message.sessionName}: ${await response.text()}`);
      return;
    }
    if (message.type === "stop-session") {
      await postToHost(sessionRoute(message.sessionName, "stop"), {});
      return;
    }
    if (message.type === "ask-for-update") {
      await postToHost(sessionRoute(message.sessionName, "ask-update"), {});
      return;
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
      // The host can be down (restarting, or `talos host stop`), so a page
      // command can fail; log it rather than let Bun quit on the rejection.
      onServerMessage: (message) =>
        void handleServerMessage(message).catch((error: unknown) =>
          log.warn(`talos: couldn't handle ${message.type} from the server (${error})`),
        ),
      onOpen: (send) => {
        sendToServer = send;
        sendFoldersOrWarn();
        sendLatest(send);
      },
      onConnectionChange: (isNowConnected) => {
        isConnected = isNowConnected;
        if (isNowConnected) return;
        sendToServer = null;
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

  followHostWithRetry();
  connectWithRetry();
};
