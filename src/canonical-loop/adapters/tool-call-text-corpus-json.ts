/**
 * Naked-JSON cases for the shared tool-call text corpus
 * (tool-call-text-corpus.ts, which appends them; same data-only rules).
 *
 * These are the extractor's second layer, not recognizer syntax: ranges 0,
 * and persist hygiene leaves bare JSON alone by design. The Claude CLI
 * prompt asks for the {"tool_calls":[…]} envelope; Claude drifts to
 * {"name","input"}. The strip and rebuild consumers run in the corpus test
 * WITHOUT offered names, so they scrub the envelope (their own regex) but
 * not the input shape, which they only match against offered names.
 */
import type { CorpusCase } from "./tool-call-text-corpus.js";

export const NAKED_JSON_CASES: ReadonlyArray<CorpusCase> = [
  {
    id: "json-tool-calls-envelope-fenced",
    text: '```json\n{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}\n```',
    expect: {
      ranges: 0,
      promoted: { name: "read", args: { path: "a.txt" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: [],
      stripDrops: ['"tool_calls"', "a.txt"],
      rebuildLeaks: 1,
      rebuildToolName: "read",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "json-tool-calls-envelope-unoffered-name",
    text: 'Plan: {"tool_calls":[{"name":"rm_rf","arguments":{"path":"/"}}]}',
    expect: {
      ranges: 0,
      promoted: null, // an unoffered name never dispatches, envelope or not
      remainingKeeps: ["Plan:"],
      sanitizedKeeps: [],
      sanitizedDrops: [],
      stripDrops: ['"tool_calls"', "rm_rf"],
      rebuildLeaks: 1,
      rebuildToolName: "rm_rf",
      streamLatchesOnFirstLine: true,
    },
  },
  {
    id: "anthropic-input-shape",
    text: '{"name":"bash","input":{"command":"ls"}}',
    expect: {
      ranges: 0,
      promoted: { name: "bash", args: { command: "ls" } },
      remainingKeeps: [],
      sanitizedKeeps: [],
      sanitizedDrops: [],
      stripDrops: [],
      rebuildLeaks: 0,
      streamLatchesOnFirstLine: false,
    },
  },
];
