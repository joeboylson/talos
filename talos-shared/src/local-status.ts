import { LOCAL_STATUS_HOST, LOCAL_STATUS_PORT, LOCAL_STATUS_ROUTE } from "./constants";

export type LocalStatus = { machineName: string; isConnected: boolean };

export const LOCAL_STATUS_URL = `http://${LOCAL_STATUS_HOST}:${LOCAL_STATUS_PORT}${LOCAL_STATUS_ROUTE}`;
