import { describe, it, expect, afterEach } from "vitest";
import {
  activatePluginToolMetadata,
  deactivatePluginToolMetadata,
} from "./plugin-system/tool-metadata.js";
import type { KernelClass, ToolRisk } from "./tool-registry.js";
import {
  isCommittingTool,
  isCommittingCall,
  opCommittedWork,
  opCommittedSubstantiveWork,
  detectCommittingCalls,
  rowCommittedWork,
  rowCommittedSubstantiveWork,
  type OpTurnToolSummary,
} from "./committing-tool-check.js";

const turns = (...tools: Array<[string, string]>) => [
  { toolCallSummary: tools.map(([tool, resultStatus]) => ({ tool, resultStatus })) },
];

/** Rows as dispatch writes them TODAY: each carries the per-call arg-aware
 *  verdict, so a `pdf` read and a `pdf create` are distinguishable under the
 *  one tool name the name-only layer sees. */
const rows = (...summary: OpTurnToolSummary[]) => [{ toolCallSummary: summary }];

const pdfCall = (action: string) => [{
  role: "assistant" as const,
  tool_calls: [{
    id: "1", type: "function" as const,
    function: { name: "pdf", arguments: JSON.stringify({ action, file_path: "a.pdf" }) },
  }],
}] as never;

const httpCall = (rawArgs: string) => [{
  role: "assistant" as const,
  tool_calls: [{
    id: "1", type: "function" as const,
    function: { name: "http_request", arguments: rawArgs },
  }],
}] as never;

describe("op-level committing predicates", () => {
  it("both ignore tool calls that did not succeed", () => {
    const failed = turns(["write", "error"]);
    expect(opCommittedWork(failed)).toBe(false);
    expect(opCommittedSubstantiveWork(failed)).toBe(false);
  });

  it("both credit a real write", () => {
    const wrote = turns(["write", "ok"]);
    expect(opCommittedWork(wrote)).toBe(true);
    expect(opCommittedSubstantiveWork(wrote)).toBe(true);
  });

  it("diverge on the task ledger: committing for replay, not progress for gating", () => {
    const planned = turns(["task_create", "ok"], ["task_update", "ok"]);
    expect(opCommittedWork(planned)).toBe(true);
    expect(opCommittedSubstantiveWork(planned)).toBe(false);
  });

  it("finds the write when planning precedes it", () => {
    expect(opCommittedSubstantiveWork(turns(["task_create", "ok"], ["edit", "ok"]))).toBe(true);
  });

  it("treats an empty op as no work", () => {
    expect(opCommittedWork([])).toBe(false);
    expect(opCommittedSubstantiveWork([])).toBe(false);
  });
});

describe("pdf is judged by its action, not its risk class", () => {
  it("is not committing on the name-only layer", () => {
    expect(isCommittingTool("pdf")).toBe(false);
  });

  it("reading documents is not substantive work", () => {
    expect(opCommittedSubstantiveWork(turns(["pdf", "ok"], ["task_create", "ok"]))).toBe(false);
  });

  it("still suppresses failover when it writes a file", () => {
    expect(detectCommittingCalls(pdfCall("create"))).toHaveLength(1);
    expect(detectCommittingCalls(pdfCall("merge"))).toHaveLength(1);
  });

  it("does not suppress failover for reads", () => {
    expect(detectCommittingCalls(pdfCall("read"))).toHaveLength(0);
    expect(detectCommittingCalls(pdfCall("extract_tables"))).toHaveLength(0);
  });

  it("treats an unknown action as committing", () => {
    expect(detectCommittingCalls(pdfCall(""))).toHaveLength(1);
  });
});

describe("isCommittingCall — the arg-aware verdict", () => {
  it("separates a pdf read from a pdf create under ONE tool name", () => {
    expect(isCommittingCall("pdf", { action: "read", file_path: "a.pdf" })).toBe(false);
    expect(isCommittingCall("pdf", { action: "extract_tables" })).toBe(false);
    expect(isCommittingCall("pdf", { action: "create", file_path: "a.pdf" })).toBe(true);
    expect(isCommittingCall("pdf", { action: "merge" })).toBe(true);
    // The name-only layer cannot: both calls look identical to it.
    expect(isCommittingTool("pdf")).toBe(false);
  });

  it("separates http_request reads from writes", () => {
    expect(isCommittingCall("http_request", { method: "GET", url: "https://x/y" })).toBe(false);
    expect(isCommittingCall("http_request", { url: "https://x/y" })).toBe(false); // defaults to GET
    expect(isCommittingCall("http_request", { method: "post", url: "https://x/y" })).toBe(true);
    expect(isCommittingCall("http_request", { method: "DELETE", url: "https://x/y" })).toBe(true);
  });

  it("separates a browser commit-click from navigation", () => {
    expect(isCommittingCall("browser", { action: "click", text: "Submit order" })).toBe(true);
    expect(isCommittingCall("browser", { action: "click", text: "Back to results" })).toBe(false);
    expect(isCommittingCall("browser", { action: "navigate", url: "https://x/y" })).toBe(false);
  });

  it("defers to the name-only verdict for every other tool", () => {
    expect(isCommittingCall("write", { file_path: "a.txt", content: "x" })).toBe(true);
    expect(isCommittingCall("read", { file_path: "a.txt" })).toBe(false);
    expect(isCommittingCall("task_create", { title: "t" })).toBe(true);
    expect(isCommittingCall("no_such_tool", {})).toBe(false);
  });

  it("is conservative when the args are missing: writers commit, browser does not", () => {
    expect(isCommittingCall("pdf", undefined)).toBe(true);
    expect(isCommittingCall("http_request", undefined)).toBe(true);
    expect(isCommittingCall("browser", undefined)).toBe(false);
  });

  it("agrees with detectCommittingCalls on the same call", () => {
    expect(isCommittingCall("pdf", { action: "read" }))
      .toBe(detectCommittingCalls(pdfCall("read")).length > 0);
    expect(isCommittingCall("pdf", { action: "create" }))
      .toBe(detectCommittingCalls(pdfCall("create")).length > 0);
  });
});

describe("http_request args that never parsed are UNKNOWN, not a defaulted GET", () => {
  // The defect: every adapter's parseArgs wraps unparseable JSON in
  // `{_raw: "…"}` — a RECORD — so the record branch ran, `method` fell back to
  // "GET", and dispatch stamped committing:false on the very call
  // detectCommittingCalls (which sees `undefined`) calls committing.
  it("treats parseArgs' {_raw} wrapper as committing, not as a GET", () => {
    expect(isCommittingCall("http_request", { _raw: '{"method":"POST","url":"htt' })).toBe(true);
  });

  it("treats a record carrying neither method nor url as committing", () => {
    expect(isCommittingCall("http_request", {})).toBe(true);
  });

  it("agrees with detectCommittingCalls on the SAME truncated call", () => {
    const truncated = '{"method":"POST","url":"https://api/x/charge","body":{"amo';
    // The writer's view: JSON.parse throws → undefined → committing.
    expect(detectCommittingCalls(httpCall(truncated))).toHaveLength(1);
    // Dispatch's view: parseArgs already wrapped it in a record.
    expect(isCommittingCall("http_request", { _raw: truncated })).toBe(true);
  });

  it("still reads a well-formed GET as idempotent", () => {
    expect(isCommittingCall("http_request", { method: "GET", url: "https://x/y" })).toBe(false);
    expect(isCommittingCall("http_request", { url: "https://x/y" })).toBe(false);
    expect(isCommittingCall("http_request", { method: "HEAD", url: "https://x/y" })).toBe(false);
  });

  it("leaves pdf alone — a record with no action already defaults to committing", () => {
    expect(isCommittingCall("pdf", { _raw: '{"action":"cre' })).toBe(true);
    expect(isCommittingCall("pdf", {})).toBe(true);
    expect(isCommittingCall("pdf", { action: "read" })).toBe(false);
  });
});

describe("detectCommittingCalls on http_request args that say nothing about the method", () => {
  // A DELIBERATE divergence from the pre-unification scanner, pinned here
  // because it shipped untested. Differential testing turned up 27 diverging
  // cases and every one is this shape: http_request whose parsed args carry
  // neither `method` nor `url`. The old inline scanner defaulted them to GET
  // and answered NOT committing, while dispatch's isCommittingCall called the
  // identical args unknown and answered committing.
  //
  // KEPT, not reverted, for two reasons. (1) The module's stated philosophy —
  // when in doubt, treat as committing; an http_request with no url is not a
  // GET, it is a call whose args were lost or never made sense, and missing an
  // auto-failover is cheaper than re-charging a card. (2) The two layers must
  // agree about the SAME call; routing both through committingCallReason is
  // what makes that true, and restoring the old answer here would re-open the
  // split that unification closed.
  const NOTHING_ABOUT_THE_METHOD: Array<[raw: string, parsed: unknown]> = [
    ["", {}],                       // the `|| "{}"` default
    ["{}", {}],
    ["true", true],
    ["123", 123],
    ['"str"', "str"],
    ["[1,2]", [1, 2]],
    ['{"body":"x"}', { body: "x" }],
    // parseArgs' failure wrapper, which dispatch sees where the writer sees a
    // JSON.parse throw.
    ['{"_raw":"{\\"method\\":\\"POST\\",\\"url\\":\\"htt"}', { _raw: '{"method":"POST","url":"htt' }],
  ];

  it("calls every one of them committing", () => {
    for (const [raw] of NOTHING_ABOUT_THE_METHOD) {
      expect(detectCommittingCalls(httpCall(raw)), raw).toHaveLength(1);
    }
  });

  it("agrees with isCommittingCall on the args those strings parse to", () => {
    for (const [raw, parsed] of NOTHING_ABOUT_THE_METHOD) {
      expect(isCommittingCall("http_request", parsed), raw).toBe(true);
    }
  });

  it("does NOT widen to a well-formed idempotent call", () => {
    for (const raw of [
      '{"method":"GET","url":"https://x/y"}',
      '{"url":"https://x/y"}',
      '{"method":"HEAD","url":"https://x/y"}',
    ]) {
      expect(detectCommittingCalls(httpCall(raw)), raw).toHaveLength(0);
    }
  });
});

describe("stored rows carry the per-call verdict", () => {
  it("credits a pdf CREATE as real work under the name a pdf READ shares", () => {
    const created = rows({ tool: "pdf", resultStatus: "ok", committing: true });
    expect(opCommittedWork(created)).toBe(true);
    expect(opCommittedSubstantiveWork(created)).toBe(true);
    // The name-only layer cannot see the difference — that is the whole bug.
    expect(isCommittingTool("pdf")).toBe(false);
  });

  it("does not credit a pdf READ", () => {
    const read = rows({ tool: "pdf", resultStatus: "ok", committing: false });
    expect(opCommittedWork(read)).toBe(false);
    expect(opCommittedSubstantiveWork(read)).toBe(false);
  });

  it("credits a committing browser click and an http_request write", () => {
    expect(opCommittedSubstantiveWork(rows({ tool: "browser", resultStatus: "ok", committing: true }))).toBe(true);
    expect(opCommittedSubstantiveWork(rows({ tool: "http_request", resultStatus: "ok", committing: true }))).toBe(true);
    expect(opCommittedSubstantiveWork(rows({ tool: "browser", resultStatus: "ok", committing: false }))).toBe(false);
    expect(opCommittedSubstantiveWork(rows({ tool: "http_request", resultStatus: "ok", committing: false }))).toBe(false);
  });

  it("REFUSED work is not work — the verdict is stamped from args, before the call ran", () => {
    for (const resultStatus of ["blocked", "declined", "error", "timeout", "cancelled"]) {
      const refused = rows({ tool: "pdf", resultStatus, committing: true });
      expect(opCommittedWork(refused)).toBe(false);
      expect(opCommittedSubstantiveWork(refused)).toBe(false);
    }
  });

  it("keeps the ledger exclusion even when the row says the call committed", () => {
    const planned = rows({ tool: "task_create", resultStatus: "ok", committing: true });
    expect(opCommittedWork(planned)).toBe(true);
    expect(opCommittedSubstantiveWork(planned)).toBe(false);
  });

  it("lets an explicit verdict override the name in BOTH directions", () => {
    expect(rowCommittedWork({ tool: "write", resultStatus: "ok", committing: false })).toBe(false);
    expect(rowCommittedWork({ tool: "read", resultStatus: "ok", committing: true })).toBe(true);
    expect(rowCommittedSubstantiveWork({ tool: "pdf", resultStatus: "ok", committing: true })).toBe(true);
    expect(rowCommittedSubstantiveWork({ tool: "task_update", resultStatus: "ok", committing: true })).toBe(false);
  });
});

describe("summary rows written before the verdict existed", () => {
  it("still decide by tool name — opCommitted* falls back when the key is absent", () => {
    // Exactly the shape readOpTurns yields for a turn already on disk: no
    // `committing` key anywhere. Behavior must be identical to before.
    const legacy = turns(["write", "ok"]);
    expect(legacy[0].toolCallSummary.every(s => !("committing" in s))).toBe(true);
    expect(opCommittedWork(legacy)).toBe(true);
    expect(opCommittedSubstantiveWork(legacy)).toBe(true);
    expect(opCommittedWork(turns(["pdf", "ok"]))).toBe(false);
  });

  it("reads a legacy row exactly as the name-only layer does, tool by tool", () => {
    for (const tool of ["write", "edit", "pdf", "browser", "http_request", "read", "task_create"]) {
      expect(rowCommittedWork({ tool, resultStatus: "ok" })).toBe(isCommittingTool(tool));
    }
  });

  it("undefined means NO VERDICT ON RECORD, never 'did not commit'", () => {
    expect(rowCommittedWork({ tool: "write", resultStatus: "ok", committing: undefined })).toBe(true);
  });
});

describe("the two layers share ONE precedence order", () => {
  // The defect: isCommittingTool checked the plugin registry FIRST, while
  // isCommittingCall checked ARG_AWARE_TOOLS first. A plugin registering a tool
  // NAMED `browser` / `pdf` / `http_request` was therefore judged by the
  // BUILT-IN tool's arg grammar — args it does not share — so the name-only
  // layer said committing while dispatch stamped `committing: false` on the
  // row, and that narrowing persisted forever.
  const token = Symbol("precedence-test");
  const meta = {
    ownerId: "precedence-test-plugin",
    activationToken: token,
    kernel: "network" as KernelClass,
    risk: "network-write" as ToolRisk,
  };

  afterEach(() => {
    for (const name of ARG_AWARE_NAMES) deactivatePluginToolMetadata(name, meta.ownerId, token);
  });

  const ARG_AWARE_NAMES = ["browser", "pdf", "http_request"];

  it("an active plugin registration outranks the arg-aware inspection", () => {
    for (const name of ARG_AWARE_NAMES) {
      activatePluginToolMetadata(name, meta);
      // Args that the BUILT-IN grammar reads as idempotent. The plugin's
      // declaration must win in both layers, not just the name-only one.
      const idempotentArgs =
        name === "http_request" ? { method: "GET", url: "https://x/y" }
        : name === "pdf" ? { action: "read" }
        : { action: "navigate", url: "https://x/y" };
      expect(isCommittingTool(name), `${name}: name-only layer`).toBe(true);
      expect(isCommittingCall(name, idempotentArgs), `${name}: arg-aware layer`).toBe(true);
      deactivatePluginToolMetadata(name, meta.ownerId, token);
    }
  });

  it("the two layers agree on every plain tool, plugin or not", () => {
    // A plugin tool that shares no name with a built-in still agrees.
    activatePluginToolMetadata("plugin_only_tool", meta);
    expect(isCommittingTool("plugin_only_tool")).toBe(true);
    expect(isCommittingCall("plugin_only_tool", { anything: 1 })).toBe(true);
    deactivatePluginToolMetadata("plugin_only_tool", meta.ownerId, token);
    expect(isCommittingTool("plugin_only_tool")).toBe(false);
    expect(isCommittingCall("plugin_only_tool", { anything: 1 })).toBe(false);
  });

  it("the legacy-override branch cannot outrank anything — the two sets are disjoint", () => {
    // This case used to be named "a legacy override also outranks the arg-aware
    // inspection" and asserted it with `secret_save`, which is not arg-aware —
    // so it could not fail whichever order the branches ran in. The property is
    // unreachable, and THAT is what is pinned instead: every arg-aware name
    // answers false at the name-only layer, which it can only do if it is in
    // NEITHER the plugin registry NOR LEGACY_COMMITTING_OVERRIDES. Put one of
    // them in the override set and this goes red — which is precisely when the
    // override-vs-args precedence becomes reachable and needs a real test. The
    // plugin case above is the only reachable proof of the shared order today.
    for (const name of ARG_AWARE_NAMES) expect(isCommittingTool(name), name).toBe(false);

    // What an override DOES pin: it is committing in both layers, even when the
    // args would read as idempotent under an arg grammar.
    expect(isCommittingTool("secret_save")).toBe(true);
    expect(isCommittingCall("secret_save", { method: "GET" })).toBe(true);
  });

  it("detectCommittingCalls uses the same order — a plugin browser still counts", () => {
    activatePluginToolMetadata("browser", meta);
    const navigate = [{
      role: "assistant" as const,
      tool_calls: [{
        id: "1", type: "function" as const,
        function: { name: "browser", arguments: JSON.stringify({ action: "navigate", url: "https://x" }) },
      }],
    }] as never;
    expect(detectCommittingCalls(navigate)).toHaveLength(1);
    deactivatePluginToolMetadata("browser", meta.ownerId, token);
    expect(detectCommittingCalls(navigate)).toHaveLength(0);
  });
});
