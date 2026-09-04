import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDesignGuardMiddleware } from "./app-design-guard.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { _resetMiddlewareStates } from "./state.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";
import { selectDesignBrief, DESIGN_CRAFT, DESIGN_ANTI_PATTERNS } from "../../tools/design-brief.js";
import type { CanonicalLoopContext, CanonicalMiddlewareResult } from "./types.js";

let workspace: string;
let saved: LAXConfig;

function appPath(appId: string, file: string): string {
  return join(workspace, "apps", appId, file);
}

/** One turn: the same write call seen before dispatch and after it. */
function ctxFor(
  file: string,
  opts: { userMessage?: string; opType?: string; status?: string; tool?: string } = {},
): CanonicalLoopContext {
  const tc = { toolCallId: "tc-1", tool: opts.tool ?? "write", args: { file_path: file } };
  return makeCanonicalLoopContext({
    op: { id: "op-adg", type: opts.opType ?? "" },
    userMessage: opts.userMessage ?? "build me a landing page for my startup",
    toolCalls: [tc],
    toolResults: [{ toolName: tc.tool, toolCallId: "tc-1", content: "ok", status: (opts.status ?? "ok") as never }],
  });
}

/** Drive both hooks in the order the loop fires them. Both are synchronous by
 *  design — nothing here waits on IO the turn would have to block for. */
function runTurn(ctx: CanonicalLoopContext): CanonicalMiddlewareResult {
  appDesignGuardMiddleware.afterModelCall!(ctx);
  const result = appDesignGuardMiddleware.afterToolExecution!(ctx);
  if (result instanceof Promise) throw new Error("app-design-guard hooks must stay synchronous");
  return result;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "adg-"));
  saved = getRuntimeConfig();
  setRuntimeConfig({ ...saved, workspace });
  _resetMiddlewareStates();
});

afterEach(() => {
  setRuntimeConfig(saved);
});

describe("app-design-guard", () => {
  it("nudges with the full design system when an agent writes a NEW app's UI by hand", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    const result = runTurn(ctxFor(appPath("pmajlabs", "index.html")));

    expect(result.kind).toBe("nudge");
    const message = (result as { message: string }).message;
    // The rules come from design-brief.ts verbatim — a fork would fail here.
    expect(message).toContain(DESIGN_CRAFT);
    expect(message).toContain(DESIGN_ANTI_PATTERNS);
    // Same archetype the build path would have selected for this request.
    expect(message).toContain(selectDesignBrief("build me a landing page for my startup").brief);
  });

  it("withholds the archetype brief when the app already exists (an update)", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    writeFileSync(appPath("pmajlabs", "index.html"), "<h1>existing</h1>");
    const result = runTurn(ctxFor(appPath("pmajlabs", "styles.css"), { userMessage: "add a contact section" }));

    expect(result.kind).toBe("nudge");
    const message = (result as { message: string }).message;
    expect(message).toContain(DESIGN_CRAFT);
    expect(message).not.toContain("DESIGN SYSTEM —");
  });

  it("fires at most once per op", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    expect(runTurn(ctxFor(appPath("pmajlabs", "index.html"))).kind).toBe("nudge");
    expect(runTurn(ctxFor(appPath("pmajlabs", "styles.css"))).kind).toBe("continue");
  });

  it("stays silent on a build_app op — that path already injects the system", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    const result = runTurn(ctxFor(appPath("pmajlabs", "index.html"), { opType: "build_app" }));
    expect(result.kind).toBe("continue");
  });

  it("ignores writes outside workspace/apps", () => {
    expect(runTurn(ctxFor(join(workspace, "notes.html"))).kind).toBe("continue");
    expect(runTurn(ctxFor(join(workspace, "apps", "loose.html"))).kind).toBe("continue");
  });

  it("ignores non-design files inside an app", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    expect(runTurn(ctxFor(appPath("pmajlabs", "PROJECT.md"))).kind).toBe("continue");
  });

  it("ignores a write that failed and non-edit tools", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    expect(runTurn(ctxFor(appPath("pmajlabs", "index.html"), { status: "error" })).kind).toBe("continue");
    expect(runTurn(ctxFor(appPath("pmajlabs", "index.html"), { tool: "read" })).kind).toBe("continue");
  });

  it("is disabled by LAX_APP_DESIGN_GUARD=0", () => {
    mkdirSync(join(workspace, "apps", "pmajlabs"), { recursive: true });
    process.env.LAX_APP_DESIGN_GUARD = "0";
    try {
      expect(runTurn(ctxFor(appPath("pmajlabs", "index.html"))).kind).toBe("continue");
    } finally {
      delete process.env.LAX_APP_DESIGN_GUARD;
    }
  });
});
