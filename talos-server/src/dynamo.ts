import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Logger } from "talos-shared";

// Each table and the one field that identifies a row in it.
export const TABLES = {
  machines: { suffix: "machines", keyField: "machineId" },
  signIns: { suffix: "sign-ins", keyField: "signInId" },
  settings: { suffix: "settings", keyField: "settingName" },
} as const;

export type TableName = keyof typeof TABLES;

export const buildTableName = (tablePrefix: string, table: TableName): string =>
  `${tablePrefix}${TABLES[table].suffix}`;

// The emulator accepts any credentials. Fixed ones keep the SDK from ever
// picking up a real AWS login that happens to be set on this computer.
const EMULATOR_CREDENTIALS = { accessKeyId: "talos-local", secretAccessKey: "talos-local" };
const TABLE_READY_TIMEOUT_SECONDS = 30;

const createDynamoClient = (isUsingEmulator: boolean) =>
  new DynamoDBClient(isUsingEmulator ? { credentials: EMULATOR_CREDENTIALS } : {});

export const createDocumentClient = (isUsingEmulator: boolean) =>
  DynamoDBDocumentClient.from(createDynamoClient(isUsingEmulator));

export type DocumentClient = ReturnType<typeof createDocumentClient>;

const createEmulatorTable = async (dynamoClient: DynamoDBClient, tableName: string, keyField: string, log: Logger) => {
  const hasTable = await dynamoClient
    .send(new DescribeTableCommand({ TableName: tableName }))
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof ResourceNotFoundException) return false;
      throw error;
    });
  if (hasTable) {
    log.detail(`table ${tableName} is already in the emulator`);
    return;
  }

  await dynamoClient.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: keyField, AttributeType: "S" }],
      KeySchema: [{ AttributeName: keyField, KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client: dynamoClient, maxWaitTime: TABLE_READY_TIMEOUT_SECONDS }, { TableName: tableName });
  log.event(`made table ${tableName} in the emulator`);
};

// The emulator starts empty every time, so the server makes its own tables
// there. On real AWS the tables are set up with the rest of the infrastructure.
export const createEmulatorTables = async (tablePrefix: string, log: Logger): Promise<void> => {
  const dynamoClient = createDynamoClient(true);
  const tableNames = Object.keys(TABLES) as TableName[];
  await Promise.all(
    tableNames.map((table) => createEmulatorTable(dynamoClient, buildTableName(tablePrefix, table), TABLES[table].keyField, log)),
  );
};
