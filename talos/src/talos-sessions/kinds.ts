// The kinds of structured output a session can hand back. The module knows none
// of them: talos passes its list in (see talos/src/session-outputs.ts), and the
// module runs the same machinery for each.
import { TALOS_MCP_SERVER_KEY } from "./constants";

export type OutputKind = {
  kind: string;
  // The tool the session calls, as its MCP server lists it.
  toolName: string;
  description: string;
  inputSchema: object;
  // Talos's check: the cleaned fields to keep, or null to turn the call down.
  readFields: (toolInput: unknown) => Record<string, unknown> | null;
  badInputReason: string;
  // Fields whose text can be typed into the session as the person's own
  // message (text, or a list of texts). Unless allowCommands, the module turns
  // the call down if one holds a command.
  typedFields: Record<string, { allowCommands: boolean }>;
  // The field, a list, whose items a click picks from.
  choicesField?: string;
  // The session ends its turn after sending one and waits for the answer.
  waits: boolean;
  // Set for a kind talos asks for: the text typed into the session to ask.
  requestText?: string;
};

// What a turn must give back, and what else it may send. A normal turn's output
// is prose; an asked-for turn's output is that kind, with nothing optional.
export type TurnShape = { output: string; optional: readonly string[] };
export const PROSE = "prose";
export const askedTurn = (kind: string): TurnShape => ({ output: kind, optional: [] });

export type Catalog = { kinds: readonly OutputKind[]; proseTurn: TurnShape };

export const mcpToolName = (toolName: string): string => `mcp__${TALOS_MCP_SERVER_KEY}__${toolName}`;
export const STRUCTURED_TOOL_PREFIX = mcpToolName("");

export const findKindByTool = (catalog: Catalog, hookToolName: string): OutputKind | undefined =>
  catalog.kinds.find((kind) => mcpToolName(kind.toolName) === hookToolName);

// What the session reads back once its output is taken, with the id talos gave it.
export const ID_PLACEHOLDER = "<id>";
export const replyWording = (kind: OutputKind): string =>
  kind.waits ? `Asked as ${ID_PLACEHOLDER}. End your turn and wait.` : `Recorded as ${ID_PLACEHOLDER}.`;

// The id talos adds to the call's input. Declared (optional) in the listed schema
// so Claude Code passes it through to the MCP server.
export const OUTPUT_ID_FIELD = "id";
export const listedSchema = (kind: OutputKind): object => {
  const schema = kind.inputSchema as { properties?: Record<string, unknown> };
  return { ...schema, properties: { ...schema.properties, [OUTPUT_ID_FIELD]: { type: "string", description: "set by talos; leave it out" } } };
};

export const findKind = (catalog: Catalog, kindName: string): OutputKind | undefined =>
  catalog.kinds.find((kind) => kind.kind === kindName);
