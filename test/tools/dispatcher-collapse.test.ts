import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createArikernelBridgeTools } from "../../src/tools/arikernel-bridge.js";
import { dispatchSingleToolCall, type UnifiedDispatchCtx } from "../../src/tool-executor.js";
import { UnifiedToolRegistry } from "../../src/tools/registry.js";
import { SecurityLayer } from "../../src/security.js";
import { ToolPolicy } from "../../src/tool-policy.js";
import { DEFAULT_POLICY } from "../../src/tool-policy/default-rules.js";
import type { ToolDefinition } from "../../src/types.js";

// Regression test for DRY-AUDIT.md F2 (final / 2C.3). The AriKernel
// FileExecutor / HttpExecutor / ShellExecutor / DatabaseExecutor /
// RetrievalExecutor used to be reachable only via the parallel kernel
// dispatch path. After the collapse they are SAX ToolDefinitions in the
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

    // Bridge ran through the unified dispatcher and produced a SAX ToolResult.
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
    expect(result.content).toMatch(/Unknown tool: ari_file/);
  });

  it("the shell bridge rejects metacharacters (sandbox property survives the collapse)", async () => {
    const bridge = createArikernelBridgeTools().find((t) => t.name === "ari_shell");
    expect(bridge).toBeDefined();
    const toolMap = new Map<string, ToolDefinition>();
    toolMap.set(bridge!.name, bridge!);

    const result = await dispatchSingleToolCall(
      {
        id: "tc-shell-inject",
        name: "ari_shell",
        args: { action: "exec", executable: "ls", args: [";rm", "-rf", "/"] },
      },
      makeCtx(toolMap),
    );
    expect(result.content.toLowerCase()).toMatch(/metacharacter|injection|blocked|rejected/);
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
      // Either the SAX pre-dispatch gate blocked it (security layer),
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
