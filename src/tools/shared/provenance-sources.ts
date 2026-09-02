/**
 * The optional `sources` provenance claim shared by the deliverable writer
 * tools (spreadsheet write/edit, document create/template, pdf create/merge,
 * presentation create/from_outline).
 *
 * `sources` is a CLAIM about where the written data came from, not an input:
 * it is never declared in pathArgs (tool-policy/tool-policies.apps.ts), so it
 * can neither gate nor widen file access, and no writer reads it — a tool's
 * output is byte-identical with or without it. The tool-execution audit seam
 * records it into the provenance sidecar (data-lineage/provenance.ts) for the
 * verification op; nothing in the tools themselves touches it.
 */

/** Entry fields mirror data-lineage/provenance.ts ProvenanceSource. */
export const SOURCES_PARAM_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      url: { type: "string", description: "Web origin the data came from" },
      file: { type: "string", description: "Workspace file the data came from" },
      ref: { type: "string", description: 'Free-form target the source fed, e.g. "rows 2-40" or "cell B5"' },
      note: { type: "string", description: 'Free-text qualifier, e.g. "headline figure" or "verbatim quote"' },
    },
  },
  description:
    "Optional provenance for the written data — one entry per source (url or file, plus ref/note). " +
    "Recorded for verification; never changes the output.",
} as const;

/** Appended verbatim to every deliverable writer's description — single
 *  grep-enforceable wording, pinned byte-exact by provenance-sources.test.ts. */
export const SOURCES_DOC_SENTENCE =
  "If the data came from a URL or file, pass sources:[{url, ref}] — it is recorded for verification.";
