// The questions talos asks a person at a terminal, drawn by Clack. Callers ask
// only when a person is there (see docs/CLI_RULES.md); every question also has
// a flag or name that answers it. Ctrl-C or Esc answers no.
import { confirm, isCancel, select, text } from "@clack/prompts";

export const askYesNo = async (message: string, initialValue: boolean): Promise<boolean> => {
  const answer = await confirm({ message, initialValue });
  return !isCancel(answer) && answer;
};

export type Choice<T> = { value: T; label: string; hint?: string };

// The value chosen, or null if the person backed out.
export const askChoice = async <T>(message: string, choices: readonly Choice<T>[]): Promise<T | null> => {
  const answer = await select<T>({ message, options: choices.map((choice) => ({ ...choice })) as never });
  return isCancel(answer) ? null : (answer as T);
};

// The text typed, or null if the person backed out. problemWith names what's
// wrong with an answer, and Clack asks again until it has none.
export const askText = async (message: string, initialValue: string, problemWith: (typed: string) => string | null): Promise<string | null> => {
  const answer = await text({ message, initialValue, validate: (typed) => problemWith(typed ?? "") ?? undefined });
  return isCancel(answer) ? null : answer;
};
