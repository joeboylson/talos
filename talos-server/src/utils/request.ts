import { parseJsonOrNull } from "talos-shared";

export const readJsonBody = async (request: Request): Promise<unknown> => parseJsonOrNull(await request.text());

// A trimmed, non-empty string field, or null for anything else.
export const readStringField = (body: unknown, fieldName: string): string | null => {
  const isObject = typeof body === "object" && body !== null;
  if (!isObject || !(fieldName in body)) return null;
  const fieldValue: unknown = Reflect.get(body, fieldName);
  const trimmedValue = typeof fieldValue === "string" ? fieldValue.trim() : "";
  return trimmedValue || null;
};

export const textResponse = (text: string, status: number): Response => new Response(text, { status });
