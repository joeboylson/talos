import {
  LOCAL_STATUS_URL,
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  type CurrentUserResponse,
  type LocalStatus,
  type MachineSummary,
  type PageToServer,
  type PairApproveResponse,
  type ServerToPage,
} from "talos-shared";
import { LOCAL_STATUS_CHECK_INTERVAL_MS } from "./constants";
import {
  describeLocalStatus,
  describeMachine,
  describeMachineCount,
  describeServerMessage,
  formatLogLine,
} from "./describe";

const requireElement = <T extends HTMLElement>(elementId: string): T => {
  const element = document.getElementById(elementId);
  if (!element) throw new Error(`index.html has no #${elementId}`);
  return element as T;
};

const loginText = requireElement("login");
const signOutButton = requireElement<HTMLButtonElement>("sign-out");
const connectionStatusText = requireElement("connection-status");
const machineList = requireElement("machines");
const pairForm = requireElement<HTMLFormElement>("pair-form");
const pairCodeInput = requireElement<HTMLInputElement>("pair-code");
const pairResultText = requireElement("pair-result");
const pingButton = requireElement<HTMLButtonElement>("ping");
const logList = requireElement("log");
const thisMachinePanel = requireElement("this-machine");
const thisMachineText = requireElement("this-machine-status");

// The page's only changing state: the current line to the server.
let serverSocket: WebSocket | null = null;

const addLogLine = (text: string) => {
  const logItem = document.createElement("li");
  logItem.textContent = formatLogLine(text, new Date());
  logList.prepend(logItem);
};

// No "are you sure?": a removed machine just pairs again to come back.
const removeMachine = async ({ machineId, machineName }: MachineSummary) => {
  const response = await fetch(`${SERVER_ROUTES.machines}/${encodeURIComponent(machineId)}`, { method: "DELETE" });
  if (!response.ok) addLogLine(`couldn't remove ${machineName}: ${response.status}`);
};

const buildMachineListItem = (machine: MachineSummary): HTMLLIElement => {
  const listItem = document.createElement("li");
  const nameText = document.createElement("span");
  nameText.textContent = describeMachine(machine);
  const removeButton = document.createElement("button");
  removeButton.textContent = "Remove";
  removeButton.onclick = () => removeMachine(machine);
  listItem.append(nameText, removeButton);
  return listItem;
};

const handleServerMessage = (message: ServerToPage) => {
  if (message.type === "machines") {
    connectionStatusText.textContent = describeMachineCount(message.machines);
    machineList.replaceChildren(...message.machines.map(buildMachineListItem));
    return;
  }
  const logLine = describeServerMessage(message);
  if (logLine) addLogLine(logLine);
};

const connectToServer = () => {
  const socketScheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.pageSocket}`);
  serverSocket = socket;

  socket.onopen = () => {
    pingButton.disabled = false;
  };

  socket.onmessage = (event) => {
    const message = decode<ServerToPage>(event.data);
    if (message) handleServerMessage(message);
  };

  socket.onclose = () => {
    pingButton.disabled = true;
    connectionStatusText.textContent = "Lost the server. Reconnecting…";
    setTimeout(connectToServer, RECONNECT_DELAY_MS);
  };
};

// On a machine without talos the request fails. That's the normal case, not
// an error, so it just keeps the panel hidden.
const checkThisMachine = async () => {
  try {
    const response = await fetch(LOCAL_STATUS_URL);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const localStatus = (await response.json()) as LocalStatus;
    thisMachineText.textContent = describeLocalStatus(localStatus);
    thisMachinePanel.hidden = false;
  } catch {
    thisMachinePanel.hidden = true;
  }
};

const approvePairing = async (event: SubmitEvent) => {
  event.preventDefault();
  const response = await fetch(SERVER_ROUTES.pairApprove, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCode: pairCodeInput.value }),
  });
  if (!response.ok) {
    pairResultText.textContent = await response.text();
    return;
  }
  const { machineName } = (await response.json()) as PairApproveResponse;
  pairResultText.textContent = `Paired ${machineName}. It connects within a few seconds.`;
  pairCodeInput.value = "";
};

const signOut = async () => {
  await fetch(SERVER_ROUTES.signOut, { method: "POST" });
  location.href = SERVER_ROUTES.signIn;
};

// Anyone not signed in goes straight to GitHub; nothing else loads first.
const start = async () => {
  const currentUserResponse = await fetch(SERVER_ROUTES.currentUser);
  if (currentUserResponse.status === 401) {
    location.href = SERVER_ROUTES.signIn;
    return;
  }
  const { login } = (await currentUserResponse.json()) as CurrentUserResponse;
  loginText.textContent = login;
  signOutButton.hidden = false;

  signOutButton.onclick = signOut;
  pairForm.onsubmit = approvePairing;
  pingButton.onclick = () => {
    serverSocket?.send(encode<PageToServer>({ type: "ping" }));
    addLogLine("ping");
  };

  connectToServer();
  checkThisMachine();
  setInterval(checkThisMachine, LOCAL_STATUS_CHECK_INTERVAL_MS);
};

start();
