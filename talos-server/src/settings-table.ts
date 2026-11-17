import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Settings } from "talos-shared";
import type { DocumentClient } from "./dynamo";

const SETTINGS_ROW = "settings";

// Anything but an explicit true counts as off, so a fresh server is closed
// to strangers until the admin opens it.
export const readSettingsRow = (row: Record<string, unknown> | undefined): Settings => ({
  allowNewPeople: row?.allowNewPeople === true,
});

export const createSettingsTable = (documentClient: DocumentClient, tableName: string) => ({
  readSettings: async (): Promise<Settings> => {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: { settingName: SETTINGS_ROW } }));
    return readSettingsRow(result.Item);
  },

  saveSettings: async (settings: Settings): Promise<void> => {
    await documentClient.send(new PutCommand({ TableName: tableName, Item: { settingName: SETTINGS_ROW, ...settings } }));
  },
});

export type SettingsTable = ReturnType<typeof createSettingsTable>;
