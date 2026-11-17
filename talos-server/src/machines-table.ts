import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DocumentClient } from "./dynamo";

export type MachineRecord = {
  machineId: string;
  machineName: string;
  ownerPersonId: string;
  keyHash: string;
  pairedAtMs: number;
};

export const createMachinesTable = (documentClient: DocumentClient, tableName: string) => ({
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

  // One page of a scan holds 1 MB, far more machines than this will have.
  listMachines: async (): Promise<MachineRecord[]> => {
    const result = await documentClient.send(new ScanCommand({ TableName: tableName }));
    return (result.Items as MachineRecord[] | undefined) ?? [];
  },
});

export type MachinesTable = ReturnType<typeof createMachinesTable>;
