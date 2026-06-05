/**
 * Generate docs/agent-capabilities.md — the catalog of things you can ask the
 * agent to do in main chat.
 *
 * The LIST is generated from src/tools/audience-map.ts (the source of truth for
 * which tools are surfaced to main chat, grouped by its category comments), so
 * it never drifts as tools are added/removed. The user-facing BLURBS are
 * curated below — friendlier than the model-facing tool descriptions. A tool
 * with no blurb still appears (name only) and is counted as "awaiting a blurb"
 * in the footer, so drift is visible.
 *
 * Run: npx tsx scripts/gen-agent-capabilities.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIENCE_MAP = join(root, "src/tools/audience-map.ts");
const OUT = join(root, "docs/agent-capabilities.md");

// ── Parse audience-map.ts: category (from `// Header` comments) + main-chat tools ──
interface Cap { category: string; tool: string }

function parseMainChatTools(src: string): Cap[] {
  const caps: Cap[] = [];
  let category = "Other";
  let expectingHeader = false;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    // A blank line or the map's opening brace marks the start of a section,
    // so the next comment line is a category header (not a continuation).
    if (line === "" || line.endsWith("{")) { expectingHeader = true; continue; }
    const comment = line.match(/^\/\/\s?(.*)$/);
    if (comment) {
      // Only the first comment line after a blank line is a section header;
      // continuation lines of a multi-line comment are ignored.
      if (expectingHeader) {
        category = comment[1].split(" — ")[0].replace(/\s*\(.*$/, "").trim() || category;
        expectingHeader = false;
      }
      continue;
    }
    expectingHeader = false;
    const entry = line.match(/^([a-z_][a-z0-9_]*):\s*\[(.*)\],?$/i);
    if (entry && /["']main-chat["']/.test(entry[2])) {
      caps.push({ category, tool: entry[1] });
    }
  }
  return caps;
}

// ── Curated, user-facing blurbs. `say` is an example phrase; `does` is the gist.
// Tools omitted here still render (name only) and count toward the drift footer.
const BLURB: Record<string, { say?: string; does: string }> = {
  read:        { does: "Read a file's contents." },
  write:       { does: "Create or overwrite a file." },
  edit:        { say: "edit index.html and change the title", does: "Make a targeted edit to a file." },
  delete_file: { does: "Delete a file." },
  bash:        { say: "run `npm test` in the project", does: "Run a shell command." },
  glob:        { does: "Find files by name pattern." },
  grep:        { does: "Search file contents." },

  web_fetch:   { say: "summarize https://example.com", does: "Fetch and read a web page." },
  web_search:  { say: "search the web for the latest on X", does: "Search the web." },
  http_request:{ does: "Make a raw HTTP request to an API." },

  setting:     { say: "change the app to dark mode", does: "Change app settings — theme, model, provider, voice, and more." },

  tool_search: { does: "Discover deeper tools not loaded by default." },

  view_image:     { say: "what's in this screenshot?", does: "Look at an image you share." },
  send_video:     { does: "Send/attach a video." },
  screen_capture: { say: "take a screenshot of my screen", does: "Capture the screen." },

  memory_search:         { say: "what do you know about my projects?", does: "Search long-term memory." },
  memory_save:           { say: "remember that I prefer tabs over spaces", does: "Save a fact to memory." },
  memory_recall:         { does: "Recall stored facts." },
  memory_get:            { does: "Fetch a specific memory entry." },
  memory_forget:         { say: "forget that I use Coinbase", does: "Mark a fact as no longer true." },
  memory_reflect:        { say: "update what you know about me", does: "Refresh entity summaries + opinion confidence." },
  memory_update_profile: { does: "Update your user profile (name, role, preferences)." },
  memory_stats:          { does: "Show memory statistics." },
  memory_consolidate:    { say: "consolidate recent conversations", does: "Extract durable facts from recent chunks." },
  memory_dream:          { say: "dream now", does: "Tidy stored facts + launch the deep agentic reflection over recent transcripts." },
  memory_ingest:         { does: "Ingest external text/history into memory." },

  operation_start:   { say: "start an operation to ship feature X", does: "Begin a long-horizon, multi-step goal." },
  operation_list:    { does: "List active operations." },
  operation_status:  { does: "Check an operation's status." },
  operation_next:    { does: "Get the next step of an operation." },
  operation_advance: { does: "Advance an operation a step." },

  op_status:   { say: "what are my background tasks doing?", does: "Check running background workers." },
  op_kill:     { say: "cancel that background task", does: "Stop a running worker." },
  op_redirect: { does: "Redirect a running worker with new instructions." },

  autopilot_start:  { say: "turn on autopilot", does: "Start autonomous multi-step execution." },
  autopilot_stop:   { does: "Stop autopilot." },
  autopilot_status: { does: "Check autopilot status." },

  self_edit: { say: "fix a bug in your own code", does: "Modify Agent X's own source via a coding agent." },

  enter_plan_mode: { say: "let's plan this first", does: "Enter plan mode (propose before acting)." },
  exit_plan_mode:  { does: "Leave plan mode and execute." },
  task_create:     { say: "add a task to refactor the parser", does: "Create a task." },
  task_update:     { does: "Update a task." },
  task_list:       { does: "List tasks." },
  task_get:        { does: "Get a task's details." },

  protocol_list:   { say: "what protocols do you have?", does: "List saved protocols (reusable workflows)." },
  protocol_create: { say: "save this as a protocol", does: "Save a reusable workflow." },
  protocol_search: { does: "Search protocols." },
  protocol_get:    { does: "Read a protocol." },
  protocol_edit:   { does: "Edit a protocol." },

  mission_schedule_create: { say: "every morning at 8, summarize my unread email", does: "Schedule a recurring mission." },
  mission_schedule_list:   { does: "List scheduled missions." },
  mission_schedule_toggle: { does: "Enable/disable a scheduled mission." },

  agent_list:   { does: "List available agents." },
  agent_spawn:  { say: "spawn an agent to research X", does: "Delegate work to a sub-agent." },
  agent_create: { say: "create a research agent named Scout", does: "Create a new named agent." },
  agent_status: { does: "Check a spawned agent's status." },
  agent_cancel: { does: "Cancel a spawned agent." },
  agent_output: { does: "Get a spawned agent's output." },

  project_create:    { say: "make a project for the dashboard work", does: "Create a project container." },
  project_list:      { does: "List projects." },
  project_add_agent: { does: "Add an agent to a project." },

  browser: { say: "open google.com and search for X", does: "Drive a real browser." },

  build_app:  { say: "build me a todo app", does: "Build a working app from a description." },
  app_create: { does: "Create a new app scaffold." },
  app_list:   { does: "List your apps." },

  sidebar_pin:   { say: "pin this to the sidebar", does: "Pin an item to the sidebar." },
  sidebar_unpin: { does: "Unpin a sidebar item." },
  sidebar_clear: { say: "clear the sidebar", does: "Clear the sidebar." },

  primal_run_build_plan: { does: "Run a staged app-build plan." },
  primal_build_status:   { does: "Check an app build's status." },
  primal_build_resume:   { does: "Resume a paused app build." },

  request_secret:  { say: "I need to store my OpenAI key", does: "Securely request + store a secret." },
  request_secrets: { does: "Request multiple secrets." },
  list_secrets:    { does: "List stored secret names (never values)." },

  document_create: { say: "write me a one-pager on X", does: "Create a document." },
  document_edit:   { does: "Edit a document." },
  document_read:   { does: "Read a document." },
};

// ── Curated intro: the headline phrases. ──
const HEADLINE = [
  "change the app to dark mode",
  "dream now",
  "build me a todo app",
  "remember that I prefer tabs over spaces",
  "search the web for the latest on X",
  "what do you know about my projects?",
  "open google.com and search for X",
  "spawn an agent to research X",
  "take a screenshot of my screen",
  "every morning at 8, summarize my unread email",
];

function main(): void {
  const caps = parseMainChatTools(readFileSync(AUDIENCE_MAP, "utf-8"));

  // Group by category, preserving first-seen order.
  const order: string[] = [];
  const byCat = new Map<string, string[]>();
  for (const { category, tool } of caps) {
    if (!byCat.has(category)) { byCat.set(category, []); order.push(category); }
    byCat.get(category)!.push(tool);
  }

  const documented = caps.filter(c => BLURB[c.tool]).length;
  const awaiting = caps.length - documented;

  const out: string[] = [];
  out.push("# Agent Capabilities — what you can ask Agent X to do");
  out.push("");
  out.push("<!-- GENERATED by scripts/gen-agent-capabilities.ts from src/tools/audience-map.ts.");
  out.push("     Do not edit by hand — run `npx tsx scripts/gen-agent-capabilities.ts` to refresh. -->");
  out.push("");
  out.push("You talk to Agent X in plain language — it picks the tool. This lists the");
  out.push("capabilities surfaced to main chat, grouped by area. (Deeper tools load on");
  out.push("demand via tool search and aren't all listed here.)");
  out.push("");
  out.push("## Common things you can say");
  out.push("");
  for (const phrase of HEADLINE) out.push(`- "${phrase}"`);
  out.push("");
  out.push("## Full capability reference");
  for (const cat of order) {
    out.push("");
    out.push(`### ${cat}`);
    out.push("");
    for (const tool of byCat.get(cat)!) {
      const b = BLURB[tool];
      if (b) {
        const say = b.say ? ` _e.g._ "${b.say}"` : "";
        out.push(`- \`${tool}\` — ${b.does}${say}`);
      } else {
        out.push(`- \`${tool}\``);
      }
    }
  }
  out.push("");
  out.push("---");
  out.push(`_${caps.length} capabilities · ${documented} with a description · ${awaiting} awaiting a blurb (add to scripts/gen-agent-capabilities.ts)._`);
  out.push("");

  writeFileSync(OUT, out.join("\n"), "utf-8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${OUT}: ${caps.length} capabilities, ${documented} documented, ${awaiting} awaiting a blurb.`);
}

main();
