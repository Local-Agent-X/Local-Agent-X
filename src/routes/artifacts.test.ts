import { describe, it, expect } from "vitest";
import { extractSessionArtifacts } from "./artifacts.js";

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
