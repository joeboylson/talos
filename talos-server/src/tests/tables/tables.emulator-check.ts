// Checks the server's tables against the AWS emulator: what the unit tests'
// fake tables can't, like key names and DynamoDB's own expressions.
// Run with `make test-db`, which starts and stops a throwaway emulator. Not
// named *.test.ts, so a plain `bun test` (which has no emulator) skips it.
import { describe, expect, test } from "bun:test";
import { ConditionalCheckFailedException, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { TABLES, buildTableName, createDocumentClient, createEmulatorTables, type TableName } from "../../dynamo";
import { createMachinesTable } from "../../machines-table";
import { createSettingsTable } from "../../settings-table";
import { createSignInsTable } from "../../sign-ins-table";
import { quietLog } from "../helpers/fakes";

// A fresh prefix each run, so a run never sees an earlier run's rows.
const TABLE_PREFIX = `test-db-${Date.now()}-`;
const tableNameOf = (table: TableName) => buildTableName(TABLE_PREFIX, table);

await createEmulatorTables(TABLE_PREFIX, quietLog);
const documentClient = createDocumentClient(true);
const machinesTable = createMachinesTable(documentClient, tableNameOf("machines"));
const signInsTable = createSignInsTable(documentClient, tableNameOf("signIns"));
const settingsTable = createSettingsTable(documentClient, tableNameOf("settings"));

test.each(Object.keys(TABLES) as TableName[])("the %s table is keyed by the field the code uses", async (table) => {
  const described = await documentClient.send(new DescribeTableCommand({ TableName: tableNameOf(table) }));
  expect(described.Table?.KeySchema).toEqual([{ AttributeName: TABLES[table].keyField, KeyType: "HASH" }]);
});

describe("machines", () => {
  const atlas = { machineId: "m-atlas", machineName: "atlas", ownerPersonId: "joe", keyHash: "hash", pairedAtMs: 1 };
  const spark = { machineId: "m-spark", machineName: "spark", ownerPersonId: "eve", keyHash: "hash", pairedAtMs: 2 };

  test("a saved machine is found by its id and listed with the others", async () => {
    await machinesTable.saveMachine(atlas);
    await machinesTable.saveMachine(spark);
    expect(await machinesTable.findMachine(atlas.machineId)).toEqual(atlas);
    const listed = await machinesTable.listMachines();
    expect(listed.toSorted((first, second) => first.machineId.localeCompare(second.machineId))).toEqual([atlas, spark]);
  });

  test("saving again replaces it, and removing it leaves it gone", async () => {
    await machinesTable.saveMachine({ ...atlas, machineName: "renamed" });
    expect((await machinesTable.findMachine(atlas.machineId))?.machineName).toBe("renamed");
    await machinesTable.removeMachine(atlas.machineId);
    expect(await machinesTable.findMachine(atlas.machineId)).toBeNull();
  });
});

describe("sign-ins", () => {
  const signIn = { signInId: "github-id:34290408", personId: "joe", displayName: "joeboylson", linkedAtMs: 5 };

  test("a saved sign-in is found by its id", async () => {
    await signInsTable.saveSignIn(signIn);
    expect(await signInsTable.findSignIn(signIn.signInId)).toEqual(signIn);
    expect(await signInsTable.findSignIn("github-id:1")).toBeNull();
  });

  test("signing out records when, and keeps the rest of the sign-in", async () => {
    await signInsTable.endSessions(signIn.signInId, 1000);
    await signInsTable.endSessions(signIn.signInId, 2000);
    expect(await signInsTable.findSignIn(signIn.signInId)).toEqual({ ...signIn, sessionsEndedAtMs: 2000 });
  });

  test("signing out a sign-in that doesn't exist fails and makes no row", async () => {
    await expect(signInsTable.endSessions("github-id:404", 1000)).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(await signInsTable.findSignIn("github-id:404")).toBeNull();
  });
});

describe("settings", () => {
  test("a fresh table reads as new people off, and a saved setting reads back", async () => {
    expect(await settingsTable.readSettings()).toEqual({ allowNewPeople: false });
    await settingsTable.saveSettings({ allowNewPeople: true });
    expect(await settingsTable.readSettings()).toEqual({ allowNewPeople: true });
  });
});
