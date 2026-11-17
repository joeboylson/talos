import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DocumentClient } from "./dynamo";

// One row per way a person signs in, pointing at the person. A person is just
// the personId their sign-ins share, so linking a second account later is
// one more row.
export type SignInRecord = { signInId: string; personId: string; displayName: string; linkedAtMs: number };

export const buildGithubSignInId = (githubLogin: string): string => `github:${githubLogin.toLowerCase()}`;

export const createSignInsTable = (documentClient: DocumentClient, tableName: string) => ({
  findSignIn: async (signInId: string): Promise<SignInRecord | null> => {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: { signInId } }));
    // Every item in this table is written by saveSignIn.
    return (result.Item as SignInRecord | undefined) ?? null;
  },

  saveSignIn: async (signIn: SignInRecord): Promise<void> => {
    await documentClient.send(new PutCommand({ TableName: tableName, Item: signIn }));
  },
});

export type SignInsTable = ReturnType<typeof createSignInsTable>;
