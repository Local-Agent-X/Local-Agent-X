// Registration completeness over the RUNTIME tool catalog.
//
// A tool is registered in several hand-maintained tables, and the older
// coverage tests sourced their names from `allTools` — a minority of tools.
// Everything that registers through a plugin (`setting`, `http_request`, the
// memory, browser, agent and protocol families, …) was invisible to them, so
// a plugin tool with no policy entry or kernel class would pass CI and hit
// default-deny (policy) or fail-closed (kernel) the first time a user called
// it. This test walks the catalog the way boot does and checks the two tables
// whose absence blocks a tool outright. The failure message names the table
// and the file to edit.
//
// Tables with their own forward checks, not repeated here: Ari action map
// (ari-action-map.test.ts), EGRESS_TOOLS ⇔ offBoxFetch
// (capability-class-gates.test.ts), the write family (write-family-drift),
// session-scoped `_sessionId` readers (session-scoped-tools.test.ts).
//
// The second half runs in the NEGATIVE direction: a tool that takes a
// path-shaped argument must declare it in `pathArgs` (or say why not), and a
// tool whose own file reaches the network must carry `offBoxFetch` (or say why
// not). Each gap this guards was a live bypass once — an attachment list, an
// image path, a context_files array, a dev server's cwd — invisible to every
// forward test, because the forward tests only check what IS declared.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";
import { collectRuntimeTools } from "./runtime-tool-names.js";
import { allTools } from "./registry-build.js";
import { ToolPolicy, auditPolicyCoverage } from "../tool-policy/index.js";
import { DEFAULT_POLICY } from "../tool-policy/default-rules.js";
import { auditKernelCoverage } from "../ari-kernel/coverage.js";
import { TOOL_PATH_ARGS } from "../tool-registry.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.data.js";
import { matchGlob } from "../tool-policy/matchers.js";
import { SECRET_ENV_TOOLS } from "./shell-secret-env.js";

let tools: Map<string, ToolDefinition>;
let names: string[];

beforeAll(async () => {
  tools = await collectRuntimeTools();
  names = [...tools.keys()].sort();
});

describe("every runtime tool, plugins included, is fully registered", () => {
  it("the catalog is wider than allTools (otherwise this test proves nothing)", () => {
    expect(names.length).toBeGreaterThan(allTools.length);
    for (const pluginTool of ["setting", "http_request", "browser", "memory_search", "agent_spawn"]) {
      expect(names, `${pluginTool} should come from a plugin`).toContain(pluginTool);
    }
  });

  it("has a covering policy rule — a tool without one is default-denied", () => {
    const report = auditPolicyCoverage(names, new ToolPolicy(DEFAULT_POLICY));
    expect(
      report.uncovered,
      `no policy rule covers: ${report.uncovered.join(", ")} — add an entry to the matching ` +
        `src/tool-policy/tool-policies.<domain>.ts fragment (kernel, risk, pathArgs if it takes a path, an allow-<name> rule)`,
    ).toEqual([]);
  });

  it("has a kernel class — a tool without one fails closed in the Ari gate", () => {
    const report = auditKernelCoverage(names);
    expect(
      report.uncovered,
      `no kernel class for: ${report.uncovered.join(", ")} — set \`kernel\` on its policy entry ` +
        `(file / http / shell / database / retrieval / secret-vault, or "internal" to skip Ari)`,
    ).toEqual([]);
  });
});

const PATH_PROP = /^(path|file_path|file|dir|directory|cwd|image|mask|attachments|context_files|project_dir|reference_images|output_dir)$/;

/** `tool.prop` → why the property is not a `pathArgs` entry. Every entry
 *  names where the value IS confined; "not a path" is a reason only when the
 *  tool never opens the value. */
const PATH_ARG_EXEMPT: Record<string, string> = {
  "process_start.cwd": "gated as a read by the shell-class evaluation (kernel-class-policy.ts), beside the command — a pathArgs entry would replace command vetting",
  "process_restart.cwd": "same shell-class cwd gate as process_start; a restart also inherits and re-vets the tracked session's cwd",
  "app_serve_backend.cwd": "same shell-class cwd gate as process_start (dev-server-tools.ts spawns through startSession)",
  "app_serve_frontend.cwd": "same shell-class cwd gate as process_start (dev-server-tools.ts spawns through startSession)",
  "memory_get.path": "a memory-dir-relative name; memory-get.ts resolves it under the memory dir and refuses traversal",
  "memory_forget.path": "a pattern matched against stored memory entries (forget.ts), never opened on disk",
  "memory_update_profile.file": "a key into PERSONALITY_FILES (save.ts), not a path",
};

/** tool → why its defining file's network use is not `offBoxFetch`. */
const EGRESS_EXEMPT: Record<string, string> = {
  protocol: "its install/refresh/update actions fetch GitHub through canonicalFetch (skills-install.ts); the other thirty actions are local, so whole-tool egress membership would taint-block them",
  mcp_add_server: "spawns an MCP server subprocess; it fetches nothing",
  marketplace_search: "reads a fixed registry URL (marketplace.ts) with nothing of the model's in the request",
  marketplace_list: "reads a fixed registry URL (marketplace.ts) with nothing of the model's in the request",
  marketplace_install: "reads a fixed registry URL (marketplace.ts) with nothing of the model's in the request",
};

const NETWORK_USE = /\bfetch\(|from ["']undici["']|from ["']node:net["']/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".test-helper.ts")) out.push(p);
  }
  return out;
}

function propsOf(tool: ToolDefinition | undefined): Record<string, unknown> {
  return (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
}

describe("every path-shaped tool argument is declared in pathArgs", () => {
  it("or is exempt with a reason naming where the value is confined", () => {
    const missing: string[] = [];
    for (const [name, tool] of tools) {
      const declared = new Set((TOOL_PATH_ARGS[name] ?? []).map((s) => s.arg));
      for (const prop of Object.keys(propsOf(tool))) {
        if (!PATH_PROP.test(prop) || declared.has(prop) || PATH_ARG_EXEMPT[`${name}.${prop}`]) continue;
        missing.push(`${name}.${prop}`);
      }
    }
    expect(
      missing,
      `path-shaped args with no pathArgs declaration: ${missing.join(", ")} — add { arg, action } to the tool's entry ` +
        `in src/tool-policy/tool-policies.<domain>.ts, or add "${missing[0]}" to PATH_ARG_EXEMPT here with the place it is confined`,
    ).toEqual([]);
  });

  it("every exemption still names a live, undeclared tool argument", () => {
    const stale = Object.keys(PATH_ARG_EXEMPT).filter((key) => {
      const [name, prop] = key.split(".");
      return !(prop in propsOf(tools.get(name))) || (TOOL_PATH_ARGS[name] ?? []).some((s) => s.arg === prop);
    });
    expect(stale, `PATH_ARG_EXEMPT entries that no longer apply: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("every tool whose defining file reaches the network is an off-box sink", () => {
  it("carries offBoxFetch: true, or is exempt with a reason", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf-8");
      if (!NETWORK_USE.test(text)) continue;
      for (const m of text.matchAll(/name: "([a-z][a-z0-9_]*)"/g)) {
        const name = m[1];
        if (!tools.has(name) || TOOL_POLICIES[name]?.offBoxFetch === true || EGRESS_EXEMPT[name]) continue;
        missing.push(`${name} (${relative(process.cwd(), file).replace(/\\/g, "/")})`);
      }
    }
    expect(
      missing,
      `tools defined in a file that fetches or opens sockets without offBoxFetch: ${missing.join(", ")} — set offBoxFetch: true on the ` +
        `policy entry and enroll the tool in EGRESS_TOOLS (src/tool-registry.ts), or add it to EGRESS_EXEMPT here with the reason`,
    ).toEqual([]);
  });

  it("every exemption names a live tool that is not already marked", () => {
    const stale = Object.keys(EGRESS_EXEMPT).filter((name) => !tools.has(name) || TOOL_POLICIES[name]?.offBoxFetch === true);
    expect(stale, `EGRESS_EXEMPT entries that no longer apply: ${stale.join(", ")}`).toEqual([]);
  });
});

// The approval card for a vault secret handed to a process (secretEnvGate) and
// the block recovery that points at secret_env key on SECRET_ENV_TOOLS. A tool
// that declares the parameter without being listed would hand over the secret
// with no card.
describe("every tool that takes secret_env is in SECRET_ENV_TOOLS", () => {
  it("declares it exactly when listed", () => {
    const declaring = names.filter((name) => "secret_env" in propsOf(tools.get(name)));
    expect(declaring, "add the tool to SECRET_ENV_TOOLS in src/tools/shell-secret-env.ts").toEqual([...SECRET_ENV_TOOLS].sort());
  });
});

// A policy glob pre-approves every tool its name matches, including tools not
// written yet. Twelve globs (payment_*, sms_*, shop_*, cron_*, …) matched no
// tool at all: standing allows waiting for any tool that took the name. Each
// glob must cover a tool that exists, or a family that registers at runtime
// and so can't be in this catalog.
const RUNTIME_FAMILIES: Record<string, string> = {
  "mcp_*": "external MCP server tools (mcp_<server>_<tool>) register when the user adds a server",
};

describe("every policy glob covers a tool that exists", () => {
  it("or a runtime-registered family, with a reason", () => {
    const dead = Object.keys(TOOL_POLICIES)
      .filter((key) => key.includes("*") && key !== "*" && !(key in RUNTIME_FAMILIES))
      .filter((glob) => !names.some((name) => matchGlob(glob, name)));
    expect(dead, "policy globs matching no runtime tool — remove them, or list the runtime family with its reason").toEqual([]);
  });

  it("every runtime family is still a glob in the table", () => {
    expect(Object.keys(RUNTIME_FAMILIES).filter((k) => !(k in TOOL_POLICIES))).toEqual([]);
  });
});

describe("the off-box reads that bypassed canonicalFetch stay routed through it", () => {
  // skills-install.ts fetched GitHub with the global fetch (no SSRF pin, no
  // web-access policy); edit-image.ts fetched a model-named image URL the
  // same way. Both now go through canonicalFetch, and the only `fetch(` left
  // in edit-image.ts is the hardcoded provider endpoint whose multipart body
  // canonicalFetch cannot carry.
  it("skills-install.ts has no bare fetch call", () => {
    const text = readFileSync(join(process.cwd(), "src", "protocols", "skills-install.ts"), "utf-8");
    expect(text).toContain("canonicalFetch");
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("edit-image.ts bare-fetches only the fixed OpenAI endpoint", () => {
    const text = readFileSync(join(process.cwd(), "src", "tools", "image-tools", "edit-image.ts"), "utf-8");
    expect(text).toContain("canonicalFetch");
    const bare = [...text.matchAll(/\bfetch\(([^,)]*)/g)].map((m) => m[1].trim());
    expect(bare).toEqual(['"https://api.openai.com/v1/images/edits"']);
  });
});
