// The kinds of structured output a session can hand back. The module knows none
// of them: talos passes its list in (see talos/src/session-outputs.ts), and the
// module runs the same machinery for each.
import { cleanLine, hasCommandMarker } from "./clean";
import { MOD_NAME } from "./constants";

export type OutputKind = {
  kind: string;
  // The tool the session calls, as the mod names it (mcp__talos__<toolName>).
  toolName: string;
  description: string;
  inputSchema: object;
  // Talos's check: the cleaned fields to keep, or null to turn the call down.
  readFields: (toolInput: unknown) => Record<string, unknown> | null;
  badInputReason: string;
  // Fields whose text can be sent into the session as the person's own
  // message (text, or a list of texts). Unless allowCommands, the module turns
  // the call down if one holds a command.
  typedFields: Record<string, { allowCommands: boolean }>;
  // The field, a list, whose items a click picks from.
  choicesField?: string;
  // The session ends its turn after sending one and waits for the answer.
  waits: boolean;
  // Set for a kind talos asks for: the text sent into the session to ask.
  requestText?: string;
};

// What a turn must give back, and what else it may send. A normal turn's output
// is prose; an asked-for turn's output is that kind, with nothing optional.
export type TurnShape = { output: string; optional: readonly string[] };
export const PROSE = "prose";
export const askedTurn = (kind: string): TurnShape => ({ output: kind, optional: [] });

export type Catalog = { kinds: readonly OutputKind[]; proseTurn: TurnShape };

export const mcpToolName = (toolName: string): string => `mcp__${MOD_NAME}__${toolName}`;
export const STRUCTURED_TOOL_PREFIX = mcpToolName("");

export const findKindByTool = (catalog: Catalog, calledName: string): OutputKind | undefined =>
  catalog.kinds.find((kind) => mcpToolName(kind.toolName) === calledName);

// What the session reads back once its output is taken, with the id talos gave it.
export const ID_PLACEHOLDER = "<id>";
export const replyWording = (kind: OutputKind): string =>
  kind.waits ? `Asked as ${ID_PLACEHOLDER}. End your turn and wait.` : `Recorded as ${ID_PLACEHOLDER}.`;

export const findKind = (catalog: Catalog, kindName: string): OutputKind | undefined =>
  catalog.kinds.find((kind) => kind.kind === kindName);

// The kinds a program gives the session runner, checked when it starts: a bad
// one is turned down there with its reason, rather than misbehaving quietly in
// a session later (an output nobody can see, a question nobody can answer).
const KIND_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_REQUEST_LENGTH = 2000;
export const catalogProblems = ({ kinds, proseTurn }: Catalog): string[] => {
  const repeated = (values: readonly string[]) => values.filter((value, index) => values.indexOf(value) !== index);
  const kindOf = (name: string) => kinds.find(({ kind }) => kind === name);
  return [
    ...kinds.filter(({ kind }) => !KIND_NAME.test(kind) || kind === PROSE).map(({ kind }) => `the kind name ${JSON.stringify(kind)} isn't a short lower-case name`),
    ...kinds.filter(({ toolName }) => !TOOL_NAME.test(toolName)).map(({ toolName }) => `the tool name ${JSON.stringify(toolName)} isn't a short lower-case name`),
    ...repeated(kinds.map(({ kind }) => kind)).map((kind) => `two kinds are called ${kind}`),
    ...repeated(kinds.map(({ toolName }) => toolName)).map((toolName) => `two kinds use the tool ${toolName}`),
    ...kinds
      .filter(({ choicesField, typedFields }) => choicesField !== undefined && !(choicesField in typedFields))
      .map(({ kind }) => `${kind}'s choices aren't one of its typed fields, so they'd be typed unchecked`),
    ...kinds
      .filter(({ requestText }) => requestText !== undefined)
      .filter(({ requestText = "" }) => !cleanLine(requestText) || requestText.length > MAX_REQUEST_LENGTH || hasCommandMarker(cleanLine(requestText)))
      .map(({ kind }) => `${kind}'s request must be plain text of at most ${MAX_REQUEST_LENGTH} characters, with no commands`),
    // A turn's own output is checked like its optional ones: an asked-for kind
    // there would be allowed with nothing to record it.
    ...[proseTurn.output, ...proseTurn.optional]
      .filter((name) => name !== PROSE || proseTurn.optional.includes(name))
      .filter((name) => !kindOf(name))
      .map((name) => `the prose turn names ${name}, which isn't a kind`),
    ...[proseTurn.output, ...proseTurn.optional].filter((name) => kindOf(name)?.requestText).map((name) => `${name} is asked for, so a prose turn can't send it`),
  ];
};
export const checkCatalog = (catalog: Catalog): void => {
  const problems = catalogProblems(catalog);
  if (problems.length > 0) throw new Error(`the session runner's kinds can't be used: ${problems.join("; ")}`);
};
