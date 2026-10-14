/**
 * Live capability-grounding eval battery (`npm run eval:grounding`).
 *
 * Guards the fix for the false-refusal failure class: the agent refusing a
 * PERMITTED action (a read it's actually allowed to do) by guessing it lacks
 * permission instead of calling the tool — observed live on Grok refusing an
 * Unrestricted-mode read as "outside the sandbox" without ever calling `read`.
 *
 * Two layers must stay in place, and a chat prompt can't prove either (the
 * model's own caution masks them). This battery checks the real artifacts
 * directly, deterministically, with no LLM:
 *   1. The constitutional "attempt, don't refuse on assumption" rule is present
 *      in the LIVE system prompt (loadSystemPrompt — the hot-reloaded source).
 *   2. The per-turn file-access grounding block states the active mode, and the
 *      live read-mode → block composition that build-system-prompt.ts performs
 *      yields the right text — plus the block is actually wired into BOTH
 *      prompt-assembly branches.
 *
 * Exit 0 = all passed; exit 1 = a regression. Run before shipping prompt or
 * file-access changes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate state under a throwaway data dir BEFORE importing any src module so
// loadFileAccessMode() reads OUR security.json, never the real ~/.lax one.
const LAX_TMP = mkdtempSync(join(tmpdir(), "grounding-eval-"));
process.env.LAX_DATA_DIR = LAX_TMP;

type Result = { group: string; name: string; pass: boolean; detail?: string };
const results: Result[] = [];
function check(group: string, name: string, pass: boolean, detail = ""): void {
  results.push({ group, name, pass, detail });
}
function setMode(mode: string): void {
  writeFileSync(join(LAX_TMP, "security.json"), JSON.stringify({ fileAccessMode: mode }));
}

async function main(): Promise<void> {
  // ── Fix 1 — the constitutional rule is in the live system prompt ──
  {
    const { loadSystemPrompt } = await import("../../src/config-loader.js");
    const prompt = loadSystemPrompt() || "";
    check("fix1-doctrine", "loadSystemPrompt() returns a non-empty prompt", prompt.length > 100);
    check("fix1-doctrine", "contains the 'attempt permitted actions' rule heading",
      prompt.includes("Attempt permitted actions") && prompt.includes("don't refuse on assumption"));
    check("fix1-doctrine", "tells the model not to carry a refusal forward",
      /carrying (an earlier |a )?refusal forward/i.test(prompt));
    check("fix1-doctrine", "demands the REAL error over a vague 'I can't access that'",
      prompt.includes("I can't access that") && /report the REAL error/i.test(prompt));
  }

  // ── Fix 2 — the per-turn grounding block (pure helper) ──
  {
    const { fileAccessGroundingBlock } = await import("../../src/agent-request/prepare-request/build-system-prompt.js");
    const unrestricted = fileAccessGroundingBlock("unrestricted");
    check("fix2-block", "unrestricted block says you can read ANY file",
      unrestricted.includes("[HARNESS NOTE: FILE ACCESS]") && unrestricted.includes("Mode: UNRESTRICTED.") && unrestricted.includes("ANY file"));
    const workspace = fileAccessGroundingBlock("workspace");
    check("fix2-block", "workspace block says reads are blocked BY POLICY, not a missing tool",
      workspace.includes("[HARNESS NOTE: FILE ACCESS]") && workspace.includes("Mode: WORKSPACE-ONLY.") &&
      workspace.includes("BY POLICY") && /not by a missing tool/i.test(workspace) &&
      workspace.includes("Settings"));
    const common = fileAccessGroundingBlock("common");
    check("fix2-block", "common block names the user content folders + points at Settings",
      common.includes("[HARNESS NOTE: FILE ACCESS]") && common.includes("Mode: COMMON.") && common.includes("Documents") && common.includes("Settings"));

    // The live read-mode → block composition build-system-prompt.ts performs.
    const { loadFileAccessMode } = await import("../../src/security/layer/security-config.js");
    setMode("unrestricted");
    check("fix2-live", "security.json mode=unrestricted → loadFileAccessMode reads it → unrestricted block",
      loadFileAccessMode() === "unrestricted" &&
      fileAccessGroundingBlock(loadFileAccessMode()) === unrestricted);
    setMode("workspace");
    check("fix2-live", "security.json mode=workspace → loadFileAccessMode reads it → workspace block",
      loadFileAccessMode() === "workspace" &&
      fileAccessGroundingBlock(loadFileAccessMode()) === workspace);
  }

  // ── Fix 2 wiring — the block reaches BOTH assembly branches ──
  // Since c307d680 the block is no longer string-concatenated per branch; it is
  // one `file-access` section added to the SystemPromptBuilder after the
  // override/base split, with policy "required" so the allocator can never shed
  // it. Exercise the real assembly both ways and look for the section.
  {
    const { buildSystemPromptWithTelemetry, fileAccessGroundingBlock } =
      await import("../../src/agent-request/prepare-request/build-system-prompt.js");
    setMode("unrestricted");
    const expectedBlock = fileAccessGroundingBlock("unrestricted");
    const baseInput = {
      channel: "web" as const,
      message: "hello",
      sessionId: `grounding-eval-${Date.now()}`,
      config: { systemPrompt: "Base prompt." } as Parameters<typeof buildSystemPromptWithTelemetry>[0]["config"],
      memoryIndex: {} as Parameters<typeof buildSystemPromptWithTelemetry>[0]["memoryIndex"],
      integrations: { getAgentContext: () => "" } as Parameters<typeof buildSystemPromptWithTelemetry>[0]["integrations"],
      allAgentTools: [],
      resolvedProvider: "anthropic",
      resolvedModel: "grounding-eval",
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      memoryNotifications: [],
      memoryCurateBlock: "",
    };
    for (const [branch, input] of [
      ["sub-agent override", { ...baseInput, systemPromptOverride: "You are a focused sub-agent." }],
      ["base prompt", baseInput],
    ] as const) {
      const built = await buildSystemPromptWithTelemetry(input);
      const section = built.renderedSections.find((s) => s.id === "file-access");
      const blockAt = built.prompt.indexOf(expectedBlock);
      check("fix2-wiring", `${branch} branch carries the live-mode block as a required 'file-access' section`,
        section !== undefined && section.policy === "required" && section.text === expectedBlock && blockAt >= 0,
        section === undefined ? "no 'file-access' section rendered"
          : section.policy !== "required" ? `section policy is '${section.policy}', so the allocator may shed it`
          : blockAt < 0 ? "section rendered but its text is not in the assembled prompt"
          : `section text differs from fileAccessGroundingBlock(loadFileAccessMode())`);
    }
  }
}

main()
  .then(() => {
    rmSync(LAX_TMP, { recursive: true, force: true });
    const fails = results.filter((r) => !r.pass);
    let lastGroup = "";
    for (const r of results) {
      if (r.group !== lastGroup) { console.log(`\n${r.group}`); lastGroup = r.group; }
      const tail = r.detail && !r.pass ? `  (${r.detail})` : "";
      console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name}${tail}`);
    }
    console.log(`\neval:grounding — ${results.length - fails.length} passed, ${fails.length} failed (${results.length} checks)`);
    process.exit(fails.length > 0 ? 1 : 0);
  })
  .catch((e) => {
    rmSync(LAX_TMP, { recursive: true, force: true });
    console.error("eval:grounding crashed:", e);
    process.exit(1);
  });
