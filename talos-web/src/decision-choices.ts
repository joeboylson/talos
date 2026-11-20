import type { SessionDecision } from "talos-shared";

export const numberChoices = (decision: SessionDecision): { label: string; choice: number }[] =>
  decision.choices.map((label, choice) => ({ label, choice }));
