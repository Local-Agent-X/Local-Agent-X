// Verify what the DEFAULT kernel preset (workspace-assistant) actually does to real
// LAX tools — via the REAL production evaluate path (startAriKernel + ariEvaluate),
// the same decision enforce-policy makes. Answers: does the blanket http-write deny
// block legitimate egress (email_send etc.) for default users?
// Run: npx tsx bench/verify-egress-preset.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAriKernel, ariEvaluate } from "../src/ari-kernel/index.js";
import { ARI_ACTION_MAP } from "../src/tool-execution/enforce-policy.js";

const SAMPLE = {
  url: "https://api.example.com/x", body: "hello", to: "user@example.com",
  subject: "hi", content: "note", command: "ls", path: "notes.txt",
};

async function main() {
  await startAriKernel(join(mkdtempSync(join(tmpdir(), "ari-verify-")), "audit.db"), "workspace-assistant", true);
  const tools = [
    "email_send", "email_draft", "calendar_create_event",   // kernel:http (action post) — suspected blocked
    "http_request", "web_fetch", "web_search",              // http (action get) — should pass
    "write", "edit", "send_video",                          // file
    "memory_save",                                          // database/mutate
    "bash",                                                 // shell
  ];
  console.log("DEFAULT preset = workspace-assistant · CLEAN call, no taint\n");
  console.log("tool".padEnd(22), "action".padEnd(8), "verdict", " reason");
  console.log("-".repeat(96));
  for (const tool of tools) {
    const action = ARI_ACTION_MAP[tool] || "exec";
    const r = await ariEvaluate(tool, action, SAMPLE, []);
    console.log(tool.padEnd(22), action.padEnd(8), (r.allowed ? "ALLOW" : "DENY ").padEnd(7), (r.reason || "").replace(/\s+/g, " ").slice(0, 74));
  }
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
