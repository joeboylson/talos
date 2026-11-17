import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export type MachineRecord = { machineId: string; machineName: string; keyHash: string; pairedAtMs: number };

// The emulator accepts any credentials. Fixed ones keep the SDK from ever
// picking up a real AWS login that happens to be set on this computer.
const EMULATOR_CREDENTIALS = { accessKeyId: "talos-local", secretAccessKey: "talos-local" };
const TABLE_READY_TIMEOUT_SECONDS = 30;

// The emulator starts empty every time, so the server makes its own table
// there. On real AWS the table is set up with the rest of the infrastructure.
export const createEmulatorTable = async (tableName: string): Promise<void> => {
  const dynamoClient = new DynamoDBClient({ credentials: EMULATOR_CREDENTIALS });
  const hasTable = await dynamoClient
    .send(new DescribeTableCommand({ TableName: tableName }))
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof ResourceNotFoundException) return false;
      throw error;
    });
  if (hasTable) return;

  await dynamoClient.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: "machineId", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "machineId", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client: dynamoClient, maxWaitTime: TABLE_READY_TIMEOUT_SECONDS }, { TableName: tableName });
  console.log(`made table ${tableName} in the emulator`);
};

export const createMachinesTable = (tableName: string, isUsingEmulator: boolean) => {
  const dynamoClient = new DynamoDBClient(isUsingEmulator ? { credentials: EMULATOR_CREDENTIALS } : {});
  const documentClient = DynamoDBDocumentClient.from(dynamoClient);

  return {
    saveMachine: async (machine: MachineRecord): Promise<void> => {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: machine }));
    },

    findMachine: async (machineId: string): Promise<MachineRecord | null> => {
      const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: { machineId } }));
      // Every item in this table is written by saveMachine.
      return (result.Item as MachineRecord | undefined) ?? null;
    },

    removeMachine: async (machineId: string): Promise<void> => {
      await documentClient.send(new DeleteCommand({ TableName: tableName, Key: { machineId } }));
    },

    // One page of a scan holds 1 MB, far more machines than anyone will pair.
    listMachines: async (): Promise<MachineRecord[]> => {
      const result = await documentClient.send(new ScanCommand({ TableName: tableName }));
      return (result.Items as MachineRecord[] | undefined) ?? [];
    },
  };
};

export type MachinesTable = ReturnType<typeof createMachinesTable>;
