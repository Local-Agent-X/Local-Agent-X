import { describe, it, expect } from "vitest";
import { extractSessionArtifacts, handleArtifactRoutes } from "./artifacts.js";
import { signServedMediaPath } from "../server/agent-file-links.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";

const meta = { id: "s1", title: "Test Session", updatedAt: 1720000000000 };

describe("extractSessionArtifacts", () => {
  it("extracts file paths from tool_calls, media breadcrumbs from tool results, links from assistant prose", () => {
    const items = extractSessionArtifacts([
      { role: "user", content: "generate a cat image and read my config" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read", arguments: JSON.stringify({ path: "C:\\Users\\me\\config.json" }) } },
          { function: { name: "generate_image", arguments: JSON.stringify({ prompt: "a cat" }) } },
          { function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/docs" }) } },
        ],
      },
      { role: "tool", content: "Image generated!\nView: /images/grok_1720000000000.png" },
      { role: "tool", content: "Fetched https://example.com/docs — see also https://noise.example.com/should-not-appear" },
      { role: "assistant", content: "Done. See [the docs](https://example.com/docs) and https://other.example.com/page for more." },
    ], meta);

    const byType = (t: string) => items.filter(i => i.type === t).map(i => i.ref);
    expect(byType("file")).toEqual(["C:\\Users\\me\\config.json"]);
    expect(byType("image")).toEqual(["/images/grok_1720000000000.png"]);
    // web_fetch arg + markdown link dedupe to one entry; bare assistant URL kept;
    // URLs inside tool dumps are NOT harvested (noise).
    expect(byType("link")).toEqual(["https://example.com/docs", "https://other.example.com/page"]);
    const mdLink = items.find(i => i.ref === "https://example.com/docs");
    expect(mdLink?.sessionTitle).toBe("Test Session");
    expect(mdLink?.ts).toBe(meta.updatedAt);
  });

  it("classifies by extension and survives malformed tool args", () => {
    const items = extractSessionArtifacts([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "write", arguments: JSON.stringify({ path: "/tmp/photo.PNG", content: "x" } ) } },
          { function: { name: "send_video", arguments: JSON.stringify({ path: "C:/videos/demo.mp4" }) } },
          { function: { name: "edit", arguments: "{not json" } },
        ],
      },
    ], meta);
    expect(items.map(i => [i.type, i.name])).toEqual([
      ["image", "photo.PNG"],
      ["video", "demo.mp4"],
    ]);
  });

  // The paths come from the tools' own rows, so every file sink surfaces: an
  // office family's file_path on its action, edit_image's image, a delete; a
  // glob's root is a directory, not an artifact.
  it("surfaces every path a tool's row declares, under whatever argument name", () => {
    const items = extractSessionArtifacts([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "presentation", arguments: JSON.stringify({ action: "create", file_path: "workspace/deck.pptx" }) } },
          { function: { name: "edit_image", arguments: JSON.stringify({ image: "workspace/logo.png", prompt: "bigger" }) } },
          { function: { name: "delete_file", arguments: JSON.stringify({ path: "workspace/old.txt" }) } },
          { function: { name: "glob", arguments: JSON.stringify({ path: "workspace/apps", pattern: "**/*.ts" }) } },
          { function: { name: "web_search", arguments: JSON.stringify({ query: "path syntax" }) } },
        ],
      },
    ], meta);
    expect(items.map(i => [i.type, i.name])).toEqual([
      ["file", "deck.pptx"],
      ["image", "logo.png"],
      ["file", "old.txt"],
    ]);
  });

  it("harvests /uploads image parts from array-form user content", () => {
    const items = extractSessionArtifacts([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "/uploads/abc123.png" } },
        ],
      },
    ], meta);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "image", ref: "/uploads/abc123.png", name: "abc123.png" });
  });
});

describe("GET /api/artifacts", () => {
  it("gives served media a link signed for that file, so the panel never puts the token in a URL", async () => {
    const session = { id: "s1", title: "T", updatedAt: 1, messages: [
      { role: "tool", content: "View: /images/cat.png" },
      { role: "assistant", content: "See https://example.com/page" },
    ] };
    const ctx = {
      config: { authToken: "tok-0123456789" },
      sessionStore: { list: () => [session], load: () => session },
    } as unknown as ServerContext;
    let body = "";
    const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = b; } } as unknown as ServerResponse;
    await handleArtifactRoutes("GET", new URL("http://127.0.0.1/api/artifacts"), { headers: {} } as IncomingMessage, res, ctx, "operator" as never);
    const items = JSON.parse(body).artifacts as Array<{ ref: string; openUrl?: string }>;
    expect(items.find((i) => i.ref === "/images/cat.png")?.openUrl).toBe(`/images/cat.png?sig=${signServedMediaPath("tok-0123456789", "/images/cat.png")}`);
    expect(items.find((i) => i.ref === "https://example.com/page")?.openUrl).toBeUndefined();
    expect(body).not.toContain("tok-0123456789");
  });

  // The tab opens on the chat on screen: one chat's artifacts, read without
  // loading every other session (520 MB of them on the owner's machine).
  it("with ?session, returns that chat's artifacts and loads no other session", async () => {
    const mk = (id: string, file: string) => ({ id, title: id, updatedAt: 1, messages: [{ role: "tool", content: `View: /images/${file}` }] });
    const sessions = [mk("scope-a", "a.png"), mk("scope-b", "b.png")];
    const loaded: string[] = [];
    const ctx = {
      config: { authToken: "tok-0123456789" },
      sessionStore: { list: () => sessions, load: (id: string) => { loaded.push(id); return sessions.find((s) => s.id === id); } },
    } as unknown as ServerContext;
    const ask = async (query: string) => {
      let body = "";
      const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = b; } } as unknown as ServerResponse;
      await handleArtifactRoutes("GET", new URL(`http://127.0.0.1/api/artifacts${query}`), { headers: {} } as IncomingMessage, res, ctx, "operator" as never);
      return (JSON.parse(body).artifacts as Array<{ ref: string }>).map((i) => i.ref);
    };
    expect(await ask("?session=scope-b")).toEqual(["/images/b.png"]);
    expect(loaded).toEqual(["scope-b"]);
    expect(await ask("?session=no-such-chat")).toEqual([]);
    expect((await ask("")).sort()).toEqual(["/images/a.png", "/images/b.png"]);
  });

  // "All chats" read every session on its first call after a restart. The
  // page shows the newest 1000 items, so the sessions older than those are
  // never needed.
  it("for all chats, stops reading once the newest sessions fill the page, and shows the same page", async () => {
    const mk = (id: string, updatedAt: number, count: number) => ({
      id, title: id, updatedAt,
      messages: [{ role: "tool", content: Array.from({ length: count }, (_, i) => `View: /images/${id}-${i}.png`).join("\n") }],
    });
    const sessions = [mk("cap-new", 30, 600), mk("cap-mid", 20, 600), mk("cap-old", 10, 600)];
    const loaded: string[] = [];
    const ctx = {
      config: { authToken: "tok-0123456789" },
      sessionStore: { list: () => sessions, load: (id: string) => { loaded.push(id); return sessions.find((s) => s.id === id); } },
    } as unknown as ServerContext;
    let body = "";
    const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = b; } } as unknown as ServerResponse;
    await handleArtifactRoutes("GET", new URL("http://127.0.0.1/api/artifacts"), { headers: {} } as IncomingMessage, res, ctx, "operator" as never);
    const items = JSON.parse(body).artifacts as Array<{ sessionId: string }>;
    expect(loaded).toEqual(["cap-new", "cap-mid"]);
    expect(items).toHaveLength(1000);
    expect(items.filter((i) => i.sessionId === "cap-new")).toHaveLength(600);
    expect(items.filter((i) => i.sessionId === "cap-mid")).toHaveLength(400);
    expect(items.some((i) => i.sessionId === "cap-old")).toBe(false);
  });
});
