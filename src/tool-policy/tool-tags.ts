/**
 * What a tool is for: the purposes roles, kits, templates, background jobs and
 * surfaces choose their tools by (tools/tool-kits.ts selectTools,
 * tool-registry.ts toolsTagged). A tag names something a new tool can be
 * judged against on its own, never who uses it today, so a tool joins every
 * set that wants its purpose by saying what it does, on its row.
 */
export const TOOL_TAGS = [
  "file-read",         // reads one file's contents
  "file-write",        // creates or replaces a whole file
  "file-edit",         // THE in-place edit verb: a targeted find-and-replace
  "file-edit-variant", // edits in place by another addressing (a line range, a batch); redundant with file-edit, so small sets leave it out
  "file-delete",       // deletes a file, or restores one a delete removed
  "file-search",       // finds files by name or by content
  "shell",             // runs a command and returns its output
  "web-search",        // searches the web
  "web-read",          // fetches and reads a web page
  "http-api",          // sends a raw HTTP request to an API
  "web-browse",        // drives a real browser
  "image-view",        // looks at an image
  "image",             // makes, edits or finds an image, or reads the text in one
  "video",             // makes, watches or sends a video
  "audio",             // transcribes the speech in a recording
  "office-doc",        // creates, edits or reads an office file (deck, doc, sheet, pdf)
  "memory-search",     // looks up what the agent's memory holds
  "memory-facts",      // saves, corrects or retracts a durable fact or profile field
  "tasks",             // keeps the run's step list
  "issues",            // works the shared issue tracker
  "team",              // sees, messages or escalates to the agent's team
  "project-brief",     // reads or updates a project's shared brief
  "delegation",        // starts another agent or worker run
  "app-build",         // builds an app, or plans or runs an app build
  "app-build-spec",    // the spec-first /app-build planning steps
  "secret-store",      // stores a secret the user hands over, or lists the stored ones
  "updates",           // checks for or installs a new version of the app
  "voice-fast",        // answers within a spoken turn, or hands the work off, and is safe to call by voice
] as const;

export type ToolTag = (typeof TOOL_TAGS)[number];

/** The user-facing line docs/agent-capabilities.md shows for a main-chat tool:
 *  what it does, and an example of how a user asks for it. */
export interface ToolBlurb {
  say?: string;
  does: string;
}

/** The row facts the sets of tools are chosen by. */
export interface ToolSelectionFacts {
  /** What the tool is for (TOOL_TAGS). REQUIRED, `[]` when no purpose in the
   *  vocabulary fits: a tool with none is in no role, kit or surface chosen by
   *  purpose, so the type makes every new tool answer. */
  tags: readonly ToolTag[];
  /** Its place in the essential order the capped model tiers keep the first N
   *  of (tools/tier-tool-set.ts ESSENTIAL_TOOLS_ORDER); 1 is kept first. Absent:
   *  not essential. Ranks are unique and run 1..N
   *  (tool-registration-completeness.test.ts). */
  essentialRank?: number;
  /** See ToolBlurb. Absent: the generated doc shows the name only and counts
   *  it as awaiting a blurb. */
  blurb?: ToolBlurb;
}
