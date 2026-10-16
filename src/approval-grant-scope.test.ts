// How far an "always allow" reaches, checked over the RUNTIME tool catalog.
// A remembered grant is keyed by computeArgsFingerprint; a tool whose key
// ignores an argument lets one approval cover every call that differs only in
// it. These tests hold every dispatchable tool to the scoping contract, so a
// new tool gets a narrow grant without anyone remembering to add it anywhere.
import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { ToolDefinition, ServerEvent } from "./types.js";
import type { ToolCallContext } from "./tool-execution/context.js";
import { collectRuntimeTools } from "./tools/runtime-tool-names.js";
import { computeArgsFingerprint, getApprovalManager } from "./approval-manager.js";
import { WHOLE_TOOL_GRANTS } from "./approval-decision.js";
import { TOOL_PATH_ARGS, hasCapability, type PathArgSpec } from "./tool-registry.js";
import { destinationsOf } from "./tool-execution/private-content-destinations.js";
import { DECLARED_DESTINATIONS, declaredDestinations, destinationKey } from "./tool-execution/send-destinations.js";

type Schema = { type?: string | string[]; enum?: unknown[] };

let tools: Map<string, ToolDefinition>;
beforeAll(async () => { tools = await collectRuntimeTools(); }, 120_000);

/** A value for an argument, and (i = 1) one that differs from `first`;
 *  undefined when the argument admits only one. */
function sample(schema: Schema | undefined, i: 0 | 1, first?: unknown): unknown {
  if (schema?.enum) return i === 0 ? schema.enum[0] : schema.enum.find((v) => v !== first);
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  switch (type) {
    case "number": case "integer": return i + 1;
    case "boolean": return i === 1;
    case "array": return [`v${i}`];
    case "object": return { k: `v${i}` };
    default: return `v${i}`;
  }
}

function callArgs(name: string, def: ToolDefinition) {
  const props = ((def.parameters as { properties?: Record<string, Schema> }).properties) ?? {};
  const specs: PathArgSpec[] = TOOL_PATH_ARGS[name] ?? [];
  const pathSpec = new Map(specs.filter((s) => !s.each).map((s) => [s.arg, s]));
  const names = new Set([...Object.keys(props), ...pathSpec.keys()]);
  const openingAction = specs.find((s) => s.forActions)?.forActions?.[0];
  const base: Record<string, unknown> = {};
  const value = (arg: string, i: 0 | 1): unknown => {
    const spec = pathSpec.get(arg);
    if (spec) {
      const p = `/grant-scope-${i}/file.txt`;
      return spec.json || props[arg]?.type === "array" ? [p] : p;
    }
    if (arg === "url" && hasCapability(name, "egress")) return `https://host-${i}.example/x`;
    if (arg === "action" && i === 0 && openingAction) return openingAction;
    return sample(props[arg], i, base[arg]);
  };
  for (const arg of names) if (!arg.startsWith("_")) base[arg] = value(arg, 0);
  return { base, value, pathArgs: new Set(specs.map((s) => s.arg)) };
}

describe("grant scope over the runtime catalog", () => {
  it("no tool's grant is the whole tool unless WHOLE_TOOL_GRANTS lists it", () => {
    const wide = [...tools.keys()].filter((name) => {
      const { base } = callArgs(name, tools.get(name)!);
      return computeArgsFingerprint(name, base) === "*" && !WHOLE_TOOL_GRANTS.has(name);
    });
    expect(wide, "these tools' 'always allow' would cover every later call").toEqual([]);
    expect([...WHOLE_TOOL_GRANTS].filter((n) => !tools.has(n)), "WHOLE_TOOL_GRANTS names no tool").toEqual([]);
  });

  it("two calls that differ in a scoped argument never share a grant", () => {
    const leaks: string[] = [];
    for (const [name, def] of tools) {
      if (WHOLE_TOOL_GRANTS.has(name)) continue;
      const { base, value, pathArgs } = callArgs(name, def);
      const named = declaredDestinations(name, base);
      const byRecipient = named !== null && named.every((d) => destinationKey(d) !== null);
      const payloadOnly = hasCapability(name, "workspace-write", base) || byRecipient;
      const recipientArg = (arg: string, changed: unknown) =>
        JSON.stringify(named) !== JSON.stringify(declaredDestinations(name, { ...base, [arg]: changed }));
      const before = computeArgsFingerprint(name, base);
      for (const arg of Object.keys(base)) {
        const changed = value(arg, 1);
        if (changed === undefined) continue;
        const after = computeArgsFingerprint(name, { ...base, [arg]: changed });
        const scoped = !payloadOnly || arg === "action" || pathArgs.has(arg) || recipientArg(arg, changed);
        if (scoped && after === before) leaks.push(`${name}.${arg} is ignored by the grant`);
        if (!scoped && after !== before) leaks.push(`${name}.${arg} is payload but splits the grant`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("a declared recipient rule belongs to a runtime tool and names what the private-content gate names", async () => {
    for (const name of Object.keys(DECLARED_DESTINATIONS)) {
      expect(tools.has(name), name).toBe(true);
      const args = { url: "https://api.example.com/v1", to: "a@example.com", chat_id: "42", phone: "+15550100", action: "open_url" };
      const ctx = { tc: { id: "c", name, arguments: "{}" }, args, sessionId: "s" };
      expect(await destinationsOf(ctx as unknown as ToolCallContext, {}), name).toEqual(declaredDestinations(name, args));
    }
  });
});

describe("grant scope — what one approval covers", () => {
  const fp = computeArgsFingerprint;

  it("an edit grant covers its directory, not another one", () => {
    expect(fp("edit_lines", { path: "/p/a/x.ts", start_line: 1, new_string: "a" }))
      .toBe(fp("edit_lines", { path: "/p/a/y.ts", start_line: 9, new_string: "b" }));
    expect(fp("edit_lines", { path: "/p/a/x.ts" })).not.toBe(fp("edit_lines", { path: "/p/b/x.ts" }));
    expect(fp("multi_edit", { path: "/p/a/x.ts", edits: [] })).not.toBe(fp("multi_edit", { path: "/p/b/x.ts", edits: [] }));
    expect(fp("bulk_replace", { path: "/p/a/x" })).not.toBe(fp("bulk_replace", { path: "/q/b/x" }));
  });

  it("a relative path never shares a grant with this process's working directory", () => {
    expect(fp("write", { path: "notes.txt" })).not.toBe(fp("write", { path: resolve("other.txt") }));
    expect(fp("write", { path: "notes.txt" })).toBe(fp("write", { path: "./todo.txt" }));
  });

  it("a process grant covers its command, not another one", () => {
    expect(fp("process_start", { command: "npm run dev" })).not.toBe(fp("process_start", { command: "node evil.js" }));
    expect(fp("process_start", { command: "npm run dev", cwd: "/p/a" })).not.toBe(fp("process_start", { command: "npm run dev", cwd: "/p/b" }));
  });

  it("an email grant covers its recipients, whatever the message says", () => {
    const send = (to: string, body = "b", cc?: string) => fp("email_send", { to, ...(cc ? { cc } : {}), subject: body, body });
    expect(send("alice@example.com", "one")).toBe(send("Alice <alice@example.com>", "two"));
    expect(send("alice@example.com")).not.toBe(send("mallory@example.com"));
    expect(send("alice@example.com")).not.toBe(send("alice@example.com", "b", "mallory@example.com"));
  });

  it("an unused url never turns a send's recipients into payload", () => {
    const send = (to: string) => fp("email_send", { to, subject: "s", body: "b", url: "https://x.example/" });
    expect(send("alice@example.com")).not.toBe(send("mallory@example.com"));
  });

  it("a send to a recipient the check cannot read covers that exact send only", () => {
    expect(fp("email_send", { to: "undisclosed-recipients:;", body: "one" })).not.toBe(fp("email_send", { to: "undisclosed-recipients:;", body: "two" }));
  });

  it("a chat grant covers its authorized chat, not another one", () => {
    expect(fp("telegram_send", { text: "one" })).toBe(fp("telegram_send", { text: "two" }));
    expect(fp("telegram_send", { text: "one" })).not.toBe(fp("telegram_send", { text: "one", chat_id: "42" }));
    expect(fp("whatsapp_send", { text: "one", phone: "+15550100" })).toBe(fp("whatsapp_send", { text: "two", phone: "+15550100" }));
    expect(fp("whatsapp_send", { text: "one", phone: "+15550100" })).not.toBe(fp("whatsapp_send", { text: "one", phone: "+15550199" }));
  });

  it("an http grant covers its host, whatever is sent there", () => {
    expect(fp("ari_http", { action: "post", url: "https://a.example/1", body: "x" }))
      .toBe(fp("ari_http", { action: "post", url: "https://a.example/2", body: "y" }));
    expect(fp("ari_http", { action: "post", url: "https://a.example/1" })).not.toBe(fp("ari_http", { action: "post", url: "https://b.example/1" }));
    expect(fp("http_request", { url: "http://localhost:3000/x" })).not.toBe(fp("http_request", { url: "http://localhost:5432/x" }));
  });

  it("a secret grant covers that secret only", () => {
    expect(fp("request_secret", { name: "GITHUB_TOKEN" })).not.toBe(fp("request_secret", { name: "AWS_SECRET" }));
  });

  it("internal `_` arguments never count", () => {
    expect(fp("process_start", { command: "ls", _sessionId: "a" })).toBe(fp("process_start", { command: "ls", _sessionId: "b" }));
  });

  it("argument order does not split a grant", () => {
    expect(fp("telegram_send", { text: "hi", chat_id: "1" })).toBe(fp("telegram_send", { chat_id: "1", text: "hi" }));
  });
});

describe("ApprovalManager — a remembered grant reaches only its scope", () => {
  it("'always allow' on edit_lines in one folder does not approve an edit in another", async () => {
    const mgr = getApprovalManager();
    const sessionId = `grant-scope-${process.hrtime.bigint().toString(36)}`;
    let approvalId = "";
    const emit = (e: ServerEvent) => { if (e.type === "approval_requested") approvalId = e.approvalId; };
    const ask = (path: string) => mgr.requestApproval({ toolName: "edit_lines", toolCallId: path, sessionId, context: "", args: { path, start_line: 1, new_string: path }, emit });

    const first = ask("/proj/src/a.ts");
    mgr.resolveApproval(approvalId, true, true);
    await expect(first).resolves.toBe(true);

    await expect(ask("/proj/src/b.ts")).resolves.toBe(true);

    approvalId = "";
    let settled = false;
    const elsewhere = ask("/home/user/.ssh/config").then((v) => { settled = true; return v; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(approvalId).not.toBe("");
    mgr.resolveApproval(approvalId, false);
    await expect(elsewhere).resolves.toBe(false);
    mgr.clearSession(sessionId);
  });
});
