/**
 * Cross-seam corpus for the ONE tool-call text recognizer
 * (tool-call-text-syntaxes.ts, public door canonical-loop/public/tool-call-text.ts).
 *
 * Every consumer of the recognizer is held to the same cases:
 *   - extractor        extractToolCallsFromText   (tool-call-text-extractor.ts)
 *   - sanitize         sanitizeModelOutput        (providers/output-sanitize.ts)
 *   - rebuild          sanitizeAssistantTextForRebuild (anthropic-client/parse.ts)
 *   - strip            stripToolCallBlocks        (anthropic-client/parse.ts)
 *   - stream latch     filterStreamDelta          (anthropic-client/parse.ts)
 *
 * Before the consolidation these five carried four regex sets that
 * disagreed (the 2026-09-08 namespaced-tag incident slipped past three of
 * them). This file is DATA ONLY: expectations are written by hand from the
 * recognizer's documented grammar, never copied from a consumer's output,
 * so a consumer drifting from the grammar fails its own describe block by
 * case id. tool-call-text-corpus.test.ts iterates it.
 *
 * Deliberately absent: prose-narration shapes ("I'll run bash …",
 * tree-style `Bash(...)`, `[Calling]` placeholders). Those heuristics are
 * not recognizer syntax and are being removed.
 */

export interface CorpusExpect {
  /** Count of recognizer ranges over the text with code spans MASKED
   *  (findTextToolCallRanges default) — the scrubbing view. */
  ranges: number;
  /** What the extractor must promote (exactly one call), or null for none.
   *  The extractor strips ``` fences before scanning, so a fenced block
   *  promotes even though the masked view reports 0 ranges. */
  promoted?: { name: string; args: Record<string, unknown> } | null;
  /** Substrings of the extractor's remainingText that must survive. */
  remainingKeeps?: string[];
  /** Substrings that must survive sanitizeModelOutput(text, "persist"). */
  sanitizedKeeps: string[];
  /** Substrings that must be gone after sanitizeModelOutput. */
  sanitizedDrops: string[];
  /** Substrings that must be gone after stripToolCallBlocks. */
  stripDrops: string[];
  /** LeakInfo count from sanitizeAssistantTextForRebuild. */
  rebuildLeaks: number;
  /** toolName on the FIRST LeakInfo (null = recognized, nothing usable). */
  rebuildToolName?: string | null;
  /** filterStreamDelta(firstLine, false).suppress. The latch is documented
   *  as WRAPPER-TAG + ```json-only and stateless: named tags, bracket
   *  markers and channel markers do not latch — that is its contract, not
   *  a disagreement. Only asserted when set. */
  streamLatchesOnFirstLine?: boolean;
}

export interface CorpusCase {
  id: string;
  text: string;
  /** Override the offered tool set for this case (default CORPUS_TOOL_NAMES). */
  tools?: string[];
  expect: CorpusExpect;
}

export const CORPUS_TOOL_NAMES: ReadonlySet<string> = new Set(["grep", "read", "bash", "glob", "write"]);

/** The 2026-09-08 muse-glimmer:30b leak, verbatim. */
export const INCIDENT_BLOCK = [
  "<atem:function_calls>",
  '<atem:invoke name="grep">',
  '<atem:parameter name="pattern">footer</atem:parameter>',
  '<atem:parameter name="path">workspace/apps/bellavida-medical-massage-clone</atem:parameter>',
  '<atem:parameter name="output_mode">content</atem:parameter>',
  "</atem:invoke>",
  "</atem:function_calls>",
].join("\n");

const INCIDENT_ARGS = {
  pattern: "footer",
  path: "workspace/apps/bellavida-medical-massage-clone",
  output_mode: "content",
};

const PLAIN_FCALLS = [
  "<function_calls>",
  '<invoke name="read">',
  '<parameter name="path">a.txt</parameter>',
  "</invoke>",
  "</function_calls>",
].join("\n");

export const TOOL_CALL_TEXT_CORPUS: ReadonlyArray<CorpusCase> = [
  {
    id: "incident-namespaced-bare",
    text: INCIDENT_BLOCK,
    expect: {
      ranges: 1,
      promoted: { name: "grep", args: INCIDENT_ARGS },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["atem:", "footer", "bellavida"],
      stripDrops: ["atem:", "footer", "bellavida"],
      rebuildLeaks: 1,
      rebuildToolName: "grep",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "incident-namespaced-with-prose",
    text: `Searching now.\n${INCIDENT_BLOCK}\nDone.`,
    expect: {
      ranges: 1,
      promoted: { name: "grep", args: INCIDENT_ARGS },
      remainingKeeps: ["Searching now.", "Done."],
      sanitizedKeeps: ["Searching now.", "Done."],
      sanitizedDrops: ["atem:", "footer", "bellavida"],
      stripDrops: ["atem:", "footer", "bellavida"],
      rebuildLeaks: 1,
      rebuildToolName: "grep",
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "function-calls-invoke-plain",
    text: PLAIN_FCALLS,
    expect: {
      ranges: 1,
      promoted: { name: "read", args: { path: "a.txt" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["<function_calls>", "<invoke", "a.txt", "</function_calls>"],
      stripDrops: ["<function_calls>", "<invoke", "a.txt", "</function_calls>"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "tool-use-parameter-children",
    text: [
      "<tool_use>",
      '<parameter name="name">bash</parameter>',
      '<parameter name="command">ls -la</parameter>',
      "</tool_use>",
    ].join("\n"),
    expect: {
      ranges: 1,
      promoted: { name: "bash", args: { command: "ls -la" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["<tool_use>", "ls -la", "</tool_use>"],
      stripDrops: ["<tool_use>", "ls -la", "</tool_use>"],
      rebuildLeaks: 1,
      rebuildToolName: "bash",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "tool-call-json-envelope",
    text: '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>',
    expect: {
      ranges: 1,
      promoted: { name: "read", args: { path: "a.txt" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["<tool_call>", "a.txt", "</tool_call>"],
      stripDrops: ["<tool_call>", "a.txt", "</tool_call>"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "function-eq-name-json",
    text: '<function=bash>{"command":"ls"}</function>',
    expect: {
      ranges: 1,
      promoted: { name: "bash", args: { command: "ls" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["<function=bash>", '"command"', "</function>"],
      stripDrops: ["<function=bash>", '"command"', "</function>"],
      rebuildLeaks: 1,
      rebuildToolName: "bash",
      streamLatchesOnFirstLine: false, // named tag, not a WRAPPER_TAG
    },
  },
  {
    id: "execute-tool-name-line-json",
    text: '<execute_tool>bash\n{"command":"ls"}</execute_tool>',
    expect: {
      ranges: 1,
      promoted: { name: "bash", args: { command: "ls" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["<execute_tool>", '"command"', "</execute_tool>"],
      stripDrops: ["<execute_tool>", '"command"', "</execute_tool>"],
      rebuildLeaks: 1,
      rebuildToolName: "bash",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "bracket-tool-prefix",
    text: '[tool:read]{"path":"a.txt"}',
    expect: {
      ranges: 1,
      promoted: { name: "read", args: { path: "a.txt" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["[tool:read]", "a.txt"],
      stripDrops: ["[tool:read]", "a.txt"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: false, // bracket marker, not a WRAPPER_TAG
    },
  },
  {
    id: "bracket-tool-request-envelope",
    text: '[TOOL_REQUEST]{"name":"glob","arguments":{"pattern":"*.ts"}}[END_TOOL_REQUEST]',
    expect: {
      ranges: 1,
      promoted: { name: "glob", args: { pattern: "*.ts" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["[TOOL_REQUEST]", "*.ts", "[END_TOOL_REQUEST]"],
      stripDrops: ["[TOOL_REQUEST]", "*.ts", "[END_TOOL_REQUEST]"],
      rebuildLeaks: 1,
      rebuildToolName: "glob",
      streamLatchesOnFirstLine: false, // bracket wrapper, not a WRAPPER_TAG
    },
  },
  {
    id: "channel-marker-to-tool",
    text: 'Let me check.\n<|channel|>commentary to=bash <|message|>{"command":"ls"}\nOK.',
    expect: {
      ranges: 1,
      promoted: { name: "bash", args: { command: "ls" } },
      remainingKeeps: ["Let me check.", "OK."],
      sanitizedKeeps: ["Let me check.", "OK."],
      sanitizedDrops: ["<|channel|>", "to=bash", "<|message|>", '"command"'],
      stripDrops: ["<|channel|>", "to=bash", "<|message|>", '"command"'],
      rebuildLeaks: 1,
      rebuildToolName: "bash",
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "unterminated-namespaced-opener",
    text: 'Searching now.\n<atem:function_calls>\n<atem:invoke name="grep">\n<atem:parameter name="pattern">foo',
    expect: {
      ranges: 1,
      promoted: null,
      remainingKeeps: ["Searching now."],
      sanitizedKeeps: ["Searching now."],
      sanitizedDrops: ["atem:", "foo"],
      stripDrops: ["atem:", "foo"],
      rebuildLeaks: 1,
      rebuildToolName: null,
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "lone-namespaced-closer",
    text: "Done here. </atem:function_calls> Thanks.",
    expect: {
      ranges: 1,
      promoted: null,
      remainingKeeps: ["Done here.", "Thanks."],
      sanitizedKeeps: ["Done here.", "Thanks."],
      sanitizedDrops: ["atem:"],
      stripDrops: ["atem:"],
      rebuildLeaks: 1,
      rebuildToolName: null,
      streamLatchesOnFirstLine: false, // closer only unlatches; never latches
    },
  },
  {
    id: "cut-between-complete-parameters",
    text: [
      "<atem:function_calls>",
      '<atem:invoke name="grep">',
      '<atem:parameter name="pattern">footer</atem:parameter>',
      '<atem:parameter name="path">workspace/apps/bellavida-medical-massage-clone</atem:parameter>',
      "",
    ].join("\n"),
    expect: {
      ranges: 1,
      promoted: null, // no closer => cut-off generation, never executes
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["atem:", "footer", "bellavida"],
      stripDrops: ["atem:", "footer", "bellavida"],
      rebuildLeaks: 1,
      rebuildToolName: null,
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "incident-inside-code-fence",
    text: "```\n" + INCIDENT_BLOCK + "\n```",
    expect: {
      ranges: 0, // masked view: fenced bytes are display text
      promoted: { name: "grep", args: INCIDENT_ARGS }, // extractor strips fences on purpose
      remainingKeeps: [],
      sanitizedKeeps: ["```\n<atem:function_calls>", "</atem:function_calls>\n```"],
      sanitizedDrops: [],
      stripDrops: [],
      rebuildLeaks: 0,
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "backticked-mention-then-real-block",
    text: 'Use `<invoke name="read">` like so:\n' + PLAIN_FCALLS + "\nthen stop.",
    expect: {
      ranges: 1,
      promoted: { name: "read", args: { path: "a.txt" } },
      remainingKeeps: ['Use `<invoke name="read">`', "like so:", "then stop."],
      sanitizedKeeps: ['Use `<invoke name="read">` like so:', "then stop."],
      sanitizedDrops: ["<function_calls>", "a.txt", "</function_calls>"],
      stripDrops: ["<function_calls>", "a.txt", "</function_calls>"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: false, // no WRAPPER_TAG on line one (named tag in backticks)
    },
  },
  {
    id: "clean-prose-with-tool-words",
    text: "The tool_result came back empty, so there was nothing to invoke; the function_calls count stays at zero.",
    expect: {
      ranges: 0,
      promoted: null,
      remainingKeeps: ["The tool_result came back empty", "function_calls count stays at zero."],
      sanitizedKeeps: ["The tool_result came back empty, so there was nothing to invoke; the function_calls count stays at zero."],
      sanitizedDrops: [],
      stripDrops: [],
      rebuildLeaks: 0,
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "bracket-bare-exact-name",
    text: '[read] {"path":"a.txt"}',
    expect: {
      ranges: 1,
      promoted: { name: "read", args: { path: "a.txt" } }, // exact match in the offered set
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: ["[read]", "a.txt"],
      stripDrops: ["[read]", "a.txt"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: false,
    },
  },
  {
    id: "bracket-bare-no-exact-name",
    text: '[read] {"path":"a.txt"}',
    tools: ["read_file", "grep", "bash"], // near-miss only: the weak marker must not fuzz
    expect: {
      ranges: 1,
      promoted: null,
      remainingKeeps: ['[read] {"path":"a.txt"}'],
      sanitizedKeeps: [],
      sanitizedDrops: ["[read]", "a.txt"],
      stripDrops: ["[read]", "a.txt"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: false,
    },
  },
];
