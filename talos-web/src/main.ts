import {
  LOCAL_STATUS_URL,
  RECONNECT_DELAY_MS,
  SERVER_ROUTES,
  decode,
  encode,
  type LocalStatus,
  type PageToServer,
  type ServerToPage,
} from "talos-shared";
import { LOCAL_STATUS_CHECK_INTERVAL_MS } from "./constants";
import { describeLocalStatus, describeMachineList, describeServerMessage, formatLogLine } from "./describe";

const requireElement = <T extends HTMLElement>(elementId: string): T => {
  const element = document.getElementById(elementId);
  if (!element) throw new Error(`index.html has no #${elementId}`);
  return element as T;
};

const machineListText = requireElement("machines");
const pingButton = requireElement<HTMLButtonElement>("ping");
const logList = requireElement("log");
const thisMachinePanel = requireElement("this-machine");
const thisMachineText = requireElement("this-machine-status");

// The page's only state: the current line to the server.
let serverSocket: WebSocket | null = null;

const addLogLine = (text: string) => {
  const logItem = document.createElement("li");
  logItem.textContent = formatLogLine(text, new Date());
  logList.prepend(logItem);
};

const handleServerMessage = (message: ServerToPage) => {
  if (message.type === "machines") {
    machineListText.textContent = describeMachineList(message.machineNames);
    return;
  }
  const logLine = describeServerMessage(message);
  if (logLine) addLogLine(logLine);
};

const connectToServer = () => {
  const socketScheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${socketScheme}://${location.host}${SERVER_ROUTES.page}`);
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
    machineListText.textContent = "Lost the server. Reconnecting…";
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

pingButton.onclick = () => {
  serverSocket?.send(encode<PageToServer>({ type: "ping" }));
  addLogLine("ping");
};

connectToServer();
checkThisMachine();
setInterval(checkThisMachine, LOCAL_STATUS_CHECK_INTERVAL_MS);
