import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DocumentClient } from "./dynamo";

// One row per way a person signs in, pointing at the person. A person is just
// the personId their sign-ins share, so linking a second account later is
// one more row.
// Sessions made at or before sessionsEndedAtMs no longer count: signing out
// sets it, which ends every session for that sign-in at once.
export type SignInRecord = {
  signInId: string;
  personId: string;
  displayName: string;
  linkedAtMs: number;
  sessionsEndedAtMs?: number;
};

// By GitHub's permanent account number, never the login, which can change hands.
export const buildGithubSignInId = (githubId: number): string => `github-id:${githubId}`;

export const createSignInsTable = (documentClient: DocumentClient, tableName: string) => ({
  findSignIn: async (signInId: string): Promise<SignInRecord | null> => {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: { signInId } }));
    // Every item in this table is written by saveSignIn.
    return (result.Item as SignInRecord | undefined) ?? null;
  },

  saveSignIn: async (signIn: SignInRecord): Promise<void> => {
    await documentClient.send(new PutCommand({ TableName: tableName, Item: signIn }));
  },

  endSessions: async (signInId: string, endedAtMs: number): Promise<void> => {
    await documentClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { signInId },
        UpdateExpression: "SET sessionsEndedAtMs = :endedAtMs",
        ConditionExpression: "attribute_exists(signInId)",
        ExpressionAttributeValues: { ":endedAtMs": endedAtMs },
      }),
    );
  },
});

export type SignInsTable = ReturnType<typeof createSignInsTable>;
