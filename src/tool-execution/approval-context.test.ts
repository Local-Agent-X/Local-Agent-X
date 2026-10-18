import { describe, expect, it } from "vitest";
import { buildApprovalContext } from "./approval-context.js";
import { createBrowserTools } from "../tools/browser-tools/index.js";
import { readTool, writeTool } from "../tools/read-write-tools.js";
import { editTool } from "../tools/edit-tools.js";
import { webFetchTool } from "../tools/web-fetch.js";
import { createHttpRequestTool } from "../tools/http-request.js";
import { buildAppTool } from "../tools/build-app.js";

const [browserTool] = createBrowserTools(() => "approval-context");
const browser = (args: Record<string, unknown>) => buildApprovalContext(browserTool, "browser", args);

describe("buildApprovalContext — browser navigate/new_tab", () => {
  it("single url renders as today", () => {
    expect(browser({ action: "new_tab", url: "https://a.com" })).toBe("Open website: https://a.com");
    expect(browser({ action: "navigate", url: "https://a.com" })).toBe("Open website: https://a.com");
  });

  it("urls[] renders ALL urls, not a blank summary", () => {
    const s = browser({ action: "new_tab", urls: ["https://a.com", "https://b.com", "https://c.com"] });
    expect(s).toBe("Open 3 websites: https://a.com, https://b.com, https://c.com");
  });

  it("urls[] takes precedence over url", () => {
    const s = browser({ action: "new_tab", url: "https://ignored.com", urls: ["https://a.com", "https://b.com"] });
    expect(s).toBe("Open 2 websites: https://a.com, https://b.com");
    expect(s).not.toContain("ignored.com");
  });

  it("urls-only call never renders the blank 'Open website: '", () => {
    const s = browser({ action: "new_tab", urls: ["https://a.com"] });
    expect(s).not.toBe("Open website: ");
    expect(s).toContain("https://a.com");
  });

  it("the full bounded urls list is disclosed", () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://site-${i}.example.com`);
    const s = browser({ action: "new_tab", urls });
    expect(s).toContain("Open 10 websites:");
    expect(s).toContain("https://site-0.example.com");
    expect(s).toContain("https://site-9.example.com");
  });

  it("empty urls array falls back to url", () => {
    expect(browser({ action: "new_tab", url: "https://a.com", urls: [] })).toBe("Open website: https://a.com");
  });
});

describe("buildApprovalContext — the line comes from the tool, or its shell command", () => {
  it("a shell command reads as the command, whichever tool runs it", () => {
    expect(buildApprovalContext(undefined, "bash", { command: "npm test" })).toBe('Run command: "npm test"');
    expect(buildApprovalContext(undefined, "process_start", { command: "npm run dev" })).toBe('Run command: "npm run dev"');
  });

  it("each tool that says what its call does says it", () => {
    expect(buildApprovalContext(writeTool, "write", { path: "src/a/b.ts", content: "xyz" })).toBe("Create file: b.ts (3 chars)");
    expect(buildApprovalContext(editTool, "edit", { path: "C:\\x\\notes.md" })).toBe("Edit file: notes.md");
    expect(buildApprovalContext(readTool, "read", { path: "a/readme.txt" })).toBe("Read file: readme.txt");
    expect(buildApprovalContext(webFetchTool, "web_fetch", { url: "https://e.com" })).toBe("Fetch webpage: https://e.com");
    expect(buildApprovalContext(createHttpRequestTool(), "http_request", { method: "POST", url: "https://api.e.com" })).toBe("API call: POST https://api.e.com");
    expect(buildApprovalContext(buildAppTool, "build_app", { name: "todo" })).toBe("Build app: todo");
  });

  it("a tool that says nothing reads as its name and the model's args, never the server's stamps", () => {
    expect(buildApprovalContext(undefined, "memory_save", { text: "x", _sessionId: "s" })).toBe('memory_save: {"text":"x"}');
  });
});
