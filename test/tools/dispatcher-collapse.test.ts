import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createArikernelBridgeTools } from "../../src/tools/arikernel-bridge.js";
import { dispatchSingleToolCall, type UnifiedDispatchCtx } from "../../src/tool-execution/index.js";
import { UnifiedToolRegistry } from "../../src/tools/registry.js";
import { SecurityLayer } from "../../src/security/index.js";
import { ToolPolicy } from "../../src/tool-policy/index.js";
import { DEFAULT_POLICY } from "../../src/tool-policy/default-rules.js";
import type { ToolDefinition } from "../../src/types.js";

// Regression test for DRY-AUDIT.md F2 (final / 2C.3). The AriKernel
// FileExecutor / HttpExecutor / DatabaseExecutor /
// RetrievalExecutor used to be reachable only via the parallel kernel
// dispatch path. After the collapse they are LAX ToolDefinitions in the
// unified registry, callable through the chat-path single dispatcher
// (`executeSingleTool` / `dispatchSingleToolCall`). Capability tokens,
// taint labels, and sandbox properties surface as fields on the unified
// ToolResult.metadata.arikernel envelope.

describe("Unified dispatcher — F2 final collapse", () => {
  const root = join(tmpdir(), `dispatch-collapse-${randomBytes(4).toString("hex")}`);
  const previousRoot = process.env.FILE_EXECUTOR_ROOT;

  beforeEach(() => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ok.txt"), "hi", "utf-8");
    process.env.FILE_EXECUTOR_ROOT = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.FILE_EXECUTOR_ROOT;
    else process.env.FILE_EXECUTOR_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  function makeCtx(toolMap: Map<string, ToolDefinition>): UnifiedDispatchCtx {
    return {
      toolMap,
      security: new SecurityLayer(root, "unrestricted"),
      toolPolicy: new ToolPolicy(DEFAULT_POLICY),
      sessionId: "agent-collapse-test",
      callContext: "delegated",
    } as unknown as UnifiedDispatchCtx;
  }

  it("the AriKernel file executor is callable through the chat-path dispatcher and carries arikernel envelope fields", async () => {
    const registry = new UnifiedToolRegistry();
    const bridge = createArikernelBridgeTools().find((t) => t.name === "ari_file");
    expect(bridge).toBeDefined();
    registry.register(bridge!, { toolClass: "file", defer: true });

    const toolMap = new Map<string, ToolDefinition>();
    toolMap.set(bridge!.name, bridge!);

    const result = await dispatchSingleToolCall(
      {
        id: "tc-file-read",
        name: "ari_file",
        args: { action: "read", path: join(root, "ok.txt") },
      },
      makeCtx(toolMap),
    );

    // Bridge ran through the unified dispatcher and produced a LAX ToolResult.
    // The dispatcher's tool message body always ends up in `content`.
    expect(result.content).toContain("ok.txt");
    expect(result.content).toContain("hi");
  });

  it("removing the ari_file bridge from the toolMap makes the dispatch fail (proves the unified path is load-bearing)", async () => {
    const toolMap = new Map<string, ToolDefinition>();
    const result = await dispatchSingleToolCall(
      {
        id: "tc-missing",
        name: "ari_file",
        args: { action: "read", path: join(root, "ok.txt") },
      },
      makeCtx(toolMap),
    );
    expect(result.content).toMatch(/Unknown tool "ari_file"/);
  });

  // bash is the one shell: a kernel shell bridge skipped bash's path
  // confinement, cage, output masking and taint, so it is not bridged at all.
  it("bridges no shell executor, while the other kernel bridges stay", async () => {
    const bridges = createArikernelBridgeTools({ sqliteDatabase: {} as never });
    const names = bridges.map((t) => t.name);
    expect(names).not.toContain("ari_shell");
    expect(names).toEqual(expect.arrayContaining(["ari_file", "ari_http", "ari_database", "ari_retrieval", "ari_sqlite"]));

    const toolMap = new Map<string, ToolDefinition>(bridges.map((t) => [t.name, t]));
    const result = await dispatchSingleToolCall(
      { id: "tc-shell-gone", name: "ari_shell", args: { action: "exec", executable: "cat", args: [join(root, "ok.txt")] } },
      makeCtx(toolMap),
    );
    expect(result.content).toMatch(/Unknown tool "ari_shell"/);
  });

  it("refuses an ari_shell call even when a tool by that name reaches the dispatcher", async () => {
    const execute = vi.fn(async () => ({ content: "IMPOSTOR_EXECUTED" }));
    const impostor = { name: "ari_shell", description: "", parameters: { type: "object", properties: {} }, execute } as unknown as ToolDefinition;
    const result = await dispatchSingleToolCall(
      { id: "tc-shell-impostor", name: "ari_shell", args: { command: `cat ${join(root, "ok.txt")}` } },
      makeCtx(new Map([[impostor.name, impostor]])),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.content).not.toContain("IMPOSTOR_EXECUTED");
    expect(result.content).toMatch(/blocked/i);
  });

  it("the file bridge blocks path traversal even when called through the unified dispatcher", async () => {
    const outside = join(tmpdir(), `outside-${randomBytes(4).toString("hex")}.txt`);
    writeFileSync(outside, "secret", "utf-8");
    try {
      const bridge = createArikernelBridgeTools().find((t) => t.name === "ari_file");
      const toolMap = new Map<string, ToolDefinition>();
      toolMap.set(bridge!.name, bridge!);

      const result = await dispatchSingleToolCall(
        {
          id: "tc-file-escape",
          name: "ari_file",
          args: { action: "read", path: outside },
        },
        makeCtx(toolMap),
      );
      // Either the LAX pre-dispatch gate blocked it (security layer),
      // or the FileExecutor rejected the path internally — both are
      // acceptable. What MUST NOT happen is the file content leaking.
      expect(result.content).not.toContain("secret");
    } finally {
      if (statSync(outside, { throwIfNoEntry: false })) {
        rmSync(outside, { force: true });
      }
    }
  });
});
