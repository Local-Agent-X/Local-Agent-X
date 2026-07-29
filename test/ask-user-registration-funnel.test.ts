/**
 * The registration funnel for `ask_user`.
 *
 * Same tripwire pattern as test/app-rebuild-registration-funnel.test.ts and
 * test/email-registration-funnel.test.ts: a finished, fully tested tool is DEAD
 * CODE until it is wired through the barrel, the audience map, the policy table,
 * the capability classes, the ARI action map and plan mode — and nothing goes red
 * when a wiring step is skipped, because the tool's own unit tests stay green.
 * Every block below asserts reachability through the REAL registry the model is
 * served from (`allTools` / `buildToolRegistry`), not a hand-written list. The
 * MUTATION each block is calibrated against is inline.
 *
 * The wiring shape being pinned: ask_user is a PURE-INTERACTION tool. It opens no
 * file, spawns nothing, sends nothing off-box — the question lands in the user's
 * own transcript — so it is kernel "internal", risk "safe", in NO capability
 * class, needs NO ARI action mapping, and is allowed in plan mode. The one place
 * it is unlike its enter/exit_plan_mode neighbours is reachability: it must be
 * EAGER, because the moment a model needs it is the moment it has a question, and
 * a tool it must tool_search for first will be replaced by a guess.
 *
 * The behavior that makes the registration worth having — the turn actually
 * ENDING on the question — is pinned in
 * src/canonical-loop/turn-loop/decide-outcome.test.ts.
 */
import { describe, it, expect } from "vitest";

import { allTools } from "../src/tools/registry-build.js";
import { askUserTool } from "../src/tools/ask-user-tool.js";
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
import { TOOLS, GATED_KERNEL_CLASSES, hasCapability } from "../src/tool-registry.js";
import { READ_ONLY_TOOLS, isReadOnlyCall } from "../src/tools/plan-tools.js";
import { localOnlyToolDecision } from "../src/local-only-policy.js";
import { AUDIENCES_BY_TOOL } from "../src/tools/audience-map.js";
import { toolPrompts } from "../src/tools/result-helpers.js";
import { isCommittingTool } from "../src/committing-tool-check.js";
import { isMutationTool, isProgressTool } from "../src/tool-mutation-check.js";

const NAME = "ask_user";

describe("ask_user — the barrel", () => {
  it("registers the tool exactly once in allTools", () => {
    // MUTATION: export the tool but never add it to registry-build.ts — the
    // dead-code end-state this funnel exists to catch. Or list it twice:
    // registry insertion is first-wins, so a duplicate silently loses.
    expect(allTools.filter((t) => t.name === NAME).length).toBe(1);
  });

  it("makes it reachable through the REAL catalog the model is served from", async () => {
    const { buildToolRegistry } = await import("../src/tools/registry-build.js");
    const { registry } = buildToolRegistry();
    expect(registry.get(NAME), `${NAME} is not in the unified registry`).toBeTruthy();
  });

  it("takes a required `question` and nothing else", () => {
    // MUTATION: make `question` optional, or add a second required arg. The
    // turn-ending terminator reads args.question off the CALL; an optional or
    // renamed field means an ok'd call the loop cannot turn into an answer.
    const p = askUserTool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(p.properties)).toEqual(["question"]);
    expect(p.required).toEqual(["question"]);
  });
});

describe("ask_user — the audience map (the wiring point that decides if it is ever used)", () => {
  it("is EAGER for main-chat AND build-intent", () => {
    // MUTATION: drop the entry (deferred) or drop "build-intent". Deferred means
    // the model must tool_search for it at the exact moment it has a question —
    // it will guess instead, which is the failure this tool removes. Dropping
    // build-intent loses it on "build me X" messages, the ones MOST likely to
    // hide an unstated decision (resolveMainChat's strip-down returns only
    // build-intent-tagged tools).
    expect(AUDIENCES_BY_TOOL[NAME]).toEqual(["main-chat", "build-intent"]);
  });

  it("is stamped onto the definition at registry build, not just declared in the map", async () => {
    const { buildToolRegistry } = await import("../src/tools/registry-build.js");
    buildToolRegistry();
    expect(allTools.find((t) => t.name === NAME)!.audiences).toEqual(["main-chat", "build-intent"]);
  });

  it("survives into the schema for an ORDINARY message with no matching keyword", async () => {
    // MUTATION: rely on the keyword router instead of an eager tag. There is no
    // keyword that predicts a fork, so the router (which resurfaces the
    // 2026-07-13 demotions) cannot stand in for the eager slot here.
    const { filterToolsForMessage } = await import("../src/agent-request/tool-filter.js");
    const surfaced = filterToolsForMessage(allTools, "wire up the payment step").map((t) => t.name);
    expect(surfaced).toContain(NAME);
  });

  it("survives the build-intent strip-down", async () => {
    const { filterToolsForMessage } = await import("../src/agent-request/tool-filter.js");
    const surfaced = filterToolsForMessage(allTools, "build me an app that takes payments").map((t) => t.name);
    expect(surfaced).toContain(NAME);
  });
});

describe("ask_user — the tool-policy table", () => {
  it("has exactly ONE entry, in the apps fragment", () => {
    // MUTATION: add a second entry in another tool-policies.*.ts fragment. The
    // fragments partition the keyspace; a duplicate key is last-wins and
    // invisible in the merged object. `apps` is the fragment that owns
    // "UI/state/config, diagnostics/planning" (enter_plan_mode, exit_plan_mode,
    // tool_search); `core` is shell + raw filesystem, which ask_user is not.
    const FRAGMENTS: Array<[string, Record<string, unknown>]> = [
      ["core", TOOL_POLICIES_CORE], ["network", TOOL_POLICIES_NETWORK], ["memory", TOOL_POLICIES_MEMORY],
      ["orchestration", TOOL_POLICIES_ORCHESTRATION], ["apps", TOOL_POLICIES_APPS], ["globs", TOOL_POLICIES_GLOBS],
    ];
    const holders = FRAGMENTS.filter(([, frag]) => Object.hasOwn(frag, NAME)).map(([name]) => name);
    expect(holders, `${NAME} is declared in ${holders.length} fragments: ${holders.join(", ")}`).toEqual(["apps"]);
    expect(TOOL_POLICIES[NAME], `${NAME} did not survive the merge`).toBe(TOOL_POLICIES_APPS[NAME]);
  });

  it("classifies it kernel:internal risk:safe — the enter/exit_plan_mode shape", () => {
    // MUTATION: give it a kernel class in GATED_KERNEL_CLASSES (it has no I/O
    // sink to gate, and it would then need an ARI action mapping it does not
    // have) or a committing risk tier (which would make a question count as
    // work in the failover / progress / mutation projections below).
    expect(TOOLS[NAME]).toEqual({ kernel: "internal", risk: "safe" });
    expect(GATED_KERNEL_CLASSES.has(TOOLS[NAME].kernel)).toBe(false);
    expect(TOOL_POLICIES.enter_plan_mode.kernel).toBe("internal");
    expect(TOOL_POLICIES.enter_plan_mode.risk).toBe("safe");
  });

  it("is ALLOWED by its OWN rule — no glob covers the name", () => {
    // MUTATION: delete the rules array and lean on a glob. There is no ask_*
    // family, so the entry alone leaves it deny-by-default: every call blocks,
    // the block is not an "ok" result, and the turn therefore never ends on the
    // question. Nothing at build time says so except this and the orphan test.
    const r = new ToolPolicy(DEFAULT_POLICY).evaluate(NAME, { question: "prod or sandbox?" }, "test");
    expect(r.allowed).toBe(true);
    expect(r.ruleId).toBe("allow-ask-user");
    expect(r.confirm).not.toBe(true);
  });

  it("declares no offBoxFetch and no path args — it has no I/O sink at all", () => {
    // MUTATION: copy offBoxFetch:true from a media tool — build-time enforced
    // against EGRESS membership semantics (capability-class-gates.test.ts).
    expect(TOOL_POLICIES[NAME].offBoxFetch).toBeUndefined();
    expect(TOOL_POLICIES[NAME].pathArgs).toBeUndefined();
  });
});

describe("ask_user — the ARI action map", () => {
  it("needs NO entry, because kernel:internal is not gated", () => {
    // MUTATION: add a mapping "just in case". The coverage test
    // (src/tool-execution/ari-action-map.test.ts) requires an entry only for
    // GATED_KERNEL_CLASSES; internal-kernel tools (enter_plan_mode, tool_search,
    // project_*) deliberately have none. An entry here would be dead data
    // asserting a kernel path this tool never takes.
    expect(ARI_ACTION_MAP[NAME]).toBeUndefined();
    expect(ARI_ACTION_MAP.enter_plan_mode).toBeUndefined();
    expect(ARI_ACTION_MAP.tool_search).toBeUndefined();
  });
});

describe("ask_user — capability classes", () => {
  it("is in NONE of the four I/O-sink classes", () => {
    // MUTATION: add it to EGRESS_TOOLS because "it sends the user a message".
    // It does not: the question goes into the user's own transcript on this box,
    // so the taint floor / secret scan / canary tripwire have nothing to guard,
    // and membership would gate a question behind a session threat restriction.
    expect(hasCapability(NAME, "egress")).toBe(false);
    expect(hasCapability(NAME, "sensitive-read")).toBe(false);
    expect(hasCapability(NAME, "workspace-write")).toBe(false);
    expect(hasCapability(NAME, "shell")).toBe(false);
  });
});

describe("ask_user — plan mode and liveness projections", () => {
  it("is ALLOWED in plan mode — asking changes nothing", () => {
    // MUTATION: leave it out of READ_ONLY_TOOLS. Plan mode's whole premise is
    // research before changes, so it is exactly when a clarifying question is
    // most useful — and the block would come back as a `blocked` result, which
    // does NOT terminate the turn, so the model asks and then guesses anyway.
    expect(READ_ONLY_TOOLS.has(NAME)).toBe(true);
    expect(isReadOnlyCall(NAME, { question: "prod or sandbox?" })).toBe(true);
  });

  it("counts as neither committing nor progress nor mutation — a question is not work", () => {
    // MUTATION: both projections DERIVE from risk:"safe" — a second reader
    // proving the policy entry above is doing its job. If a question counted as
    // progress, an agent that only ever asked would keep resetting the
    // discovery-loop and no-progress counters.
    expect(isCommittingTool(NAME)).toBe(false);
    expect(isProgressTool(NAME)).toBe(false);
    expect(isMutationTool(NAME)).toBe(false);
  });
});

describe("ask_user — strict local-only mode", () => {
  it("is allowed, like every other local-only tool", () => {
    // MUTATION: add it to REMOTE_ONLY_TOOLS in local-only-policy.ts. Nothing
    // leaves the box; refusing it would strand a local-only run on a fork.
    expect(localOnlyToolDecision(NAME, { question: "x" }, { localOnlyMode: true }).allowed).toBe(true);
    expect(localOnlyToolDecision(NAME, { question: "x" }, { localOnlyMode: false }).allowed).toBe(true);
  });
});

describe("ask_user — the prompt section", () => {
  it("ships a tool prompt that says the turn ENDS and scopes when to use it", () => {
    // MUTATION: drop the toolPrompts entry. The registration is then complete
    // and the tool is still barely used (or over-used): a question tool is the
    // one tool a model will over-reach for, and the only lever on that is prose.
    const prompt = toolPrompts[NAME]();
    expect(prompt.toLowerCase()).toContain("ends your turn");
    expect(prompt.toLowerCase()).toMatch(/never|do not|don't/);
  });

  it("reaches the system prompt through the real builder", async () => {
    const { buildToolRegistry } = await import("../src/tools/registry-build.js");
    const { promptSection } = buildToolRegistry();
    expect(promptSection).toContain(`**${NAME}**`);
  });
});

describe("ask_user — the tool itself", () => {
  it("succeeds on a real question, which is what the turn loop keys on", async () => {
    const r = await askUserTool.execute({ question: "Production Clover token, or sandbox first?" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("turn ends here");
  });

  it("ERRORS on a blank question rather than ending the turn on nothing", async () => {
    // A silent no-op here would end the op showing the user an empty bubble.
    // An error keeps the turn open (the terminator requires resultStatus "ok")
    // and hands the model a correctable message.
    const r = await askUserTool.execute({ question: "   " });
    expect(r.isError).toBe(true);
    const missing = await askUserTool.execute({});
    expect(missing.isError).toBe(true);
  });

  it("refuses a wall of text posing as a question", async () => {
    const r = await askUserTool.execute({ question: "x".repeat(2001) });
    expect(r.isError).toBe(true);
  });

  it("declares itself read-only and retry-safe", () => {
    // MUTATION: mark it non-idempotent. Re-delivering the same question after a
    // transient wobble is exactly safe, and readOnly lets it batch alongside the
    // calls the model made in the same breath.
    expect(askUserTool.readOnly).toBe(true);
    expect(askUserTool.effect).toEqual({ class: "read-only" });
  });
});
