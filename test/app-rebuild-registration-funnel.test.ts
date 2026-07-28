/**
 * The registration funnel for `app_rebuild`.
 *
 * Same tripwire pattern as test/email-registration-funnel.test.ts: a finished,
 * fully tested tool is DEAD CODE until it is wired through the barrel, the
 * policy table, the ARI action map, and the capability classes — and nothing
 * goes red when a wiring step is skipped, because the tool's own unit tests
 * stay green. Every block below asserts reachability through the REAL registry
 * the model is served from (`allTools` / `buildToolRegistry`), not a
 * hand-written list. MUTATION each block is calibrated against is inline.
 *
 * The wiring shape being pinned: app_rebuild is a SUBPROCESS SPAWNER (it runs
 * `npx vite build` through the canonical static-build runner), so everything
 * must match the app_serve_frontend precedent — kernel "shell", risk "shell",
 * shell + egress capability classes, blocked in strict local-only mode —
 * EXCEPT reachability: unlike the builder-only app_serve_* pair, app_rebuild
 * exists precisely because the MAIN agent needed it (the shell guard
 * false-blocked its bash rebuild and it hand-patched built JS instead).
 */
import { describe, it, expect } from "vitest";

import { allTools } from "../src/tools/registry-build.js";
import { appRebuildTool } from "../src/tools/app-rebuild-tool.js";
import { TOOL_POLICIES_NETWORK } from "../src/tool-policy/tool-policies.network.js";
import { TOOL_POLICIES_CORE } from "../src/tool-policy/tool-policies.core.js";
import { TOOL_POLICIES_MEMORY } from "../src/tool-policy/tool-policies.memory.js";
import { TOOL_POLICIES_ORCHESTRATION } from "../src/tool-policy/tool-policies.orchestration.js";
import { TOOL_POLICIES_APPS } from "../src/tool-policy/tool-policies.apps.js";
import { TOOL_POLICIES_GLOBS } from "../src/tool-policy/tool-policies.globs.js";
import { TOOL_POLICIES } from "../src/tool-policy/tool-policies.data.js";
import { ToolPolicy } from "../src/tool-policy/index.js";
import { DEFAULT_POLICY } from "../src/tool-policy/default-rules.js";
import { ARI_ACTION_MAP } from "../src/tool-execution/ari-action-map.js";
import { TOOLS, hasCapability } from "../src/tool-registry.js";
import { READ_ONLY_TOOLS, isReadOnlyCall } from "../src/tools/plan-tools.js";
import { localOnlyToolDecision } from "../src/local-only-policy.js";
import { AUDIENCES_BY_TOOL } from "../src/tools/audience-map.js";
import { isCommittingTool } from "../src/committing-tool-check.js";
import { isProgressTool } from "../src/tool-mutation-check.js";

const NAME = "app_rebuild";

describe("app_rebuild — the barrel", () => {
  it("registers the tool exactly once in allTools", () => {
    // MUTATION: export the tool but never add it to registry-build.ts — the
    // dead-code end-state this funnel exists to catch. Or list it twice: a
    // duplicate silently wins or loses at unifiedRegistry.register().
    expect(allTools.filter((t) => t.name === NAME).length).toBe(1);
  });

  it("makes it reachable through the REAL catalog the model is served from", async () => {
    const { buildToolRegistry } = await import("../src/tools/registry-build.js");
    const { registry } = buildToolRegistry();
    expect(registry.get(NAME), `${NAME} is not in the unified registry`).toBeTruthy();
  });
});

describe("app_rebuild — the tool-policy table", () => {
  it("has exactly ONE entry, in the apps fragment", () => {
    // MUTATION: add a second entry in another tool-policies.*.ts fragment.
    // The fragments partition the keyspace; a duplicate key is last-wins and
    // invisible in the merged object.
    const FRAGMENTS: Array<[string, Record<string, unknown>]> = [
      ["core", TOOL_POLICIES_CORE], ["network", TOOL_POLICIES_NETWORK], ["memory", TOOL_POLICIES_MEMORY],
      ["orchestration", TOOL_POLICIES_ORCHESTRATION], ["apps", TOOL_POLICIES_APPS], ["globs", TOOL_POLICIES_GLOBS],
    ];
    const holders = FRAGMENTS.filter(([, frag]) => Object.hasOwn(frag, NAME)).map(([name]) => name);
    expect(holders, `${NAME} is declared in ${holders.length} fragments: ${holders.join(", ")}`).toEqual(["apps"]);
    expect(TOOL_POLICIES[NAME], `${NAME} did not survive the merge`).toBe(TOOL_POLICIES_APPS[NAME]);
  });

  it("classifies it kernel:shell risk:shell — the app_serve_* subprocess-spawner shape", () => {
    // MUTATION: give it kernel "internal" (skips the kernel shell defense
    // pipeline for a real subprocess spawn) or a softer risk tier (drops it
    // out of the top autonomy gate its siblings sit in).
    expect(TOOL_POLICIES[NAME].kernel).toBe("shell");
    expect(TOOL_POLICIES[NAME].risk).toBe("shell");
    expect(TOOLS[NAME]).toEqual({ kernel: "shell", risk: "shell" });
    // Same entry shape as the precedent pair.
    expect(TOOL_POLICIES.app_serve_frontend.kernel).toBe("shell");
    expect(TOOL_POLICIES.app_serve_frontend.risk).toBe("shell");
  });

  it("is ALLOWED through the default policy via the app_* glob (no orphan deny)", () => {
    // MUTATION: rename the tool off the app_ prefix, or drop the app_* glob.
    // A kernel tool with no covering rule is deny-by-default — every call
    // blocks and nothing at build time says so except this and the orphan test.
    const r = new ToolPolicy(DEFAULT_POLICY).evaluate(NAME, { app: "todo-app" }, "test");
    expect(r.allowed).toBe(true);
    expect(r.ruleId).toBe("allow-apps");
  });

  it("declares no offBoxFetch and no path args — the subprocess is the sink, not a payload upload", () => {
    // MUTATION: copy offBoxFetch:true from a media tool — build-time enforced
    // against EGRESS membership semantics (capability-class-gates.test.ts).
    expect(TOOL_POLICIES[NAME].offBoxFetch).toBeUndefined();
    expect(TOOL_POLICIES[NAME].pathArgs).toBeUndefined();
  });
});

describe("app_rebuild — the ARI action map", () => {
  it('maps to "exec" — the ONLY schema-valid action for kernel class "shell"', () => {
    // MUTATION: map it to "post" (or any http verb). SHELL_ACTIONS in
    // packages/arikernel/core/src/types/actions.ts is ["exec"]; the kernel's
    // toolCallRequestSchema.parse rejects anything else, and ariRequired mode
    // turns that throw into a hard block on EVERY call — the image_search
    // failure shape (2026-06-10).
    expect(ARI_ACTION_MAP[NAME]).toBe("exec");
  });
});

describe("app_rebuild — capability classes", () => {
  it("is shell-class AND egress-class, exactly like app_serve_frontend", () => {
    // MUTATION: leave it out of SHELL_TOOLS / EGRESS_TOOLS in tool-registry.ts.
    // Out of shell, the kernel-cage/worktree shell gates key past it; out of
    // egress, the taint floor + secret scan + canary tripwire early-return
    // CONTINUE for a tool that spawns a subprocess able to carry data off-box.
    expect(hasCapability(NAME, "shell")).toBe(true);
    expect(hasCapability(NAME, "egress")).toBe(true);
    expect(hasCapability("app_serve_frontend", "shell")).toBe(true);
    expect(hasCapability("app_serve_frontend", "egress")).toBe(true);
  });

  it("is NOT sensitive-read — keeps the gate-atomicity invariant (R4-09)", () => {
    // MUTATION: add it to SENSITIVE_READ_TOOLS. A tool in both classes can
    // self-race its own egress gate against its own taint floor;
    // validateCapabilitySets throws at module load.
    expect(hasCapability(NAME, "sensitive-read")).toBe(false);
  });
});

describe("app_rebuild — plan mode and liveness projections", () => {
  it("is refused by plan mode — it mutates dist/ and stops dev servers", () => {
    // MUTATION: add it to READ_ONLY_TOOLS. Plan mode's premise is that nothing
    // it permits changes the world; a rebuild overwrites dist/ and can stop a
    // running frontend dev server.
    expect(READ_ONLY_TOOLS.has(NAME)).toBe(false);
    expect(isReadOnlyCall(NAME, { app: "x" })).toBe(false);
  });

  it("counts as committing + progress via the ONE risk taxonomy", () => {
    // MUTATION: both projections DERIVE from risk:"shell" — a second reader
    // proving the policy entry above is doing its job. isCommittingTool false
    // would let auto-failover REPLAY a turn that already rebuilt (harmless-ish)
    // and, worse, signals the risk tier silently changed.
    expect(isCommittingTool(NAME)).toBe(true);
    expect(isProgressTool(NAME)).toBe(true);
  });
});

describe("app_rebuild — strict local-only mode", () => {
  it("is blocked, like every other subprocess spawner", () => {
    // MUTATION: leave it out of REMOTE_ONLY_TOOLS in local-only-policy.ts.
    // `npx vite build` can hit the npm registry; in strict local-only mode the
    // whole shell family is refused (bash, app_serve_*, build_app).
    const d = localOnlyToolDecision(NAME, { app: "x" }, { localOnlyMode: true });
    expect(d.allowed).toBe(false);
  });

  it("is allowed when local-only mode is off", () => {
    expect(localOnlyToolDecision(NAME, { app: "x" }, { localOnlyMode: false }).allowed).toBe(true);
  });
});

describe("app_rebuild — audience tagging is deliberately untouched", () => {
  it("stays deferred, like app_create/app_list — no audience-map entry", () => {
    // MUTATION: tag it in audience-map.ts. The app_* family is deferred on
    // purpose; the keyword router surfaces the prefix on the messages that
    // need it, and one eagerly-tagged member would occupy schema on every
    // unrelated turn while its siblings stay deferred.
    expect(AUDIENCES_BY_TOOL[NAME]).toBeUndefined();
  });

  it("is surfaced by the keyword router that carries the app_ prefix", async () => {
    // MUTATION: rename the tool off the app_ prefix. Deferred + unmatched by
    // the /\bapp\b|dashboard|tracker/ rule = unreachable in practice however
    // correctly it is registered.
    const { filterToolsForMessage } = await import("../src/agent-request/tool-filter.js");
    const surfaced = filterToolsForMessage(allTools, "rebuild my todo app after my edits").map((t) => t.name);
    expect(surfaced).toContain(NAME);
  });
});

describe("app_rebuild — retry semantics", () => {
  it("declares idempotent-mutation, not read-only", () => {
    // MUTATION: mark it readOnly (parallel batching would co-schedule a build
    // with writes to the same app) or leave `effect` off (unset = treated as
    // non-idempotent, so the retry layer would never safely re-run a wobbled
    // build even though re-running vite build is exactly safe).
    expect(appRebuildTool.effect).toEqual({ class: "idempotent-mutation" });
    expect(appRebuildTool.readOnly).toBeUndefined();
  });
});
