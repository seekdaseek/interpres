/** Types for the MCP -> AssemblyAI Voice Agent tool conversion. */

// ---------------------------------------------------------------- MCP side

/** A JSON Schema as it arrives from an MCP server. Deliberately loose. */
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  examples?: unknown[];
  default?: unknown;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  [k: string]: unknown;
};

/** One entry of an MCP `tools/list` result. */
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  [k: string]: unknown;
};

/** The parts of an MCP `initialize` result we use. */
export type McpServerInfo = {
  name?: string;
  title?: string;
  version?: string;
};

export type McpInitializeResult = {
  protocolVersion?: string;
  serverInfo?: McpServerInfo;
  instructions?: string;
  capabilities?: Record<string, unknown>;
};

// ------------------------------------------------- Voice Agent (target) side

/**
 * A Voice Agent API function tool. `type`, `name`, `description` and
 * `parameters` are all required by the API (voice-agent-api.yaml,
 * ToolDefinition.required), so `description` is never left empty.
 */
export type VoiceAgentTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  execution_mode?: 'interactive' | 'hold';
  /** 1-300, default 120 per the spec. */
  timeout_seconds?: number;
};

// --------------------------------------------------------------- conversion

/** Why a `pattern` was dropped, or why it was kept. */
export type PatternVerdict =
  | { kept: true; pattern: string }
  | { kept: false; pattern: string; reason: string; normaliser?: NormaliserId };

/** Normalisers applied to an argument value before `tools/call`. */
export type NormaliserId = 'strip_non_digits' | 'collapse_whitespace' | 'trim';

export type ArgumentNormaliser = {
  /** Dotted path within the arguments object, e.g. `card_number`. */
  path: string;
  normaliser: NormaliserId;
  /** The pattern we dropped, kept for the record. */
  droppedPattern?: string;
};

/** Everything the converter learned while converting one tool. */
export type ToolConversionReport = {
  /** Name as the MCP server declares it. Used for `tools/call`. */
  mcpName: string;
  /** Name as the Voice Agent API sees it. */
  voiceName: string;
  nameSanitised: boolean;
  descriptionSynthesised: boolean;
  descriptionTruncated: boolean;
  /** Count of `$ref` pointers resolved. */
  refsResolved: number;
  /** Count of `allOf` members merged. */
  allOfFlattened: number;
  /** `anyOf`/`oneOf` unions collapsed, with how. */
  unionsCollapsed: number;
  /** `anyOf: [T, null]` optionals unwrapped. */
  nullableUnwrapped: number;
  patterns: PatternVerdict[];
  normalisers: ArgumentNormaliser[];
  /** True if any hint (enum/format/examples/pattern) survived on any property. */
  hasHints: boolean;
  /** Non-fatal notes, e.g. a `$ref` cycle we broke. */
  warnings: string[];
};

export type ConvertedTool = {
  tool: VoiceAgentTool;
  report: ToolConversionReport;
  /** The MCP tool as the server declared it: annotations and original patterns, for the gate. */
  source?: McpTool;
};

export type ConversionFailure = {
  mcpName: string;
  reason: string;
};

export type CatalogConversion = {
  converted: ConvertedTool[];
  failures: ConversionFailure[];
  stats: CatalogStats;
};

export type CatalogStats = {
  toolsIn: number;
  toolsConverted: number;
  convertedWithHints: number;
  namesSanitised: number;
  descriptionsSynthesised: number;
  descriptionsTruncated: number;
  patternsKept: number;
  patternsDropped: number;
  refsResolved: number;
  allOfFlattened: number;
  unionsCollapsed: number;
  nullableUnwrapped: number;
  failed: number;
};

export type ConvertOptions = {
  /**
   * Max characters for a tool description. The Voice Agent docs state no
   * limit; this is our own budget, since descriptions are the model's main
   * tool-selection signal and every tool's description is in every prompt.
   */
  maxDescriptionChars?: number;
  /** Max characters for a single property description. */
  maxPropertyDescriptionChars?: number;
  /** Max nesting depth to walk before giving up on a schema. */
  maxDepth?: number;
  /** Names already taken, so sanitising cannot collide with them. */
  reserved?: Iterable<string>;
};
