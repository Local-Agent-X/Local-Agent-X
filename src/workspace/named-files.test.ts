import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesNamedInReply } from "./named-files.js";

// A workspace on disk, so "the file exists" is the real check the desktop makes.
const base = mkdtempSync(join(tmpdir(), "lax-named-files-"));
const workspace = join(base, "Documents", "Local Agent X", "workspace");
for (const file of [
  "black-friday-sale/bf-post-1080x1350.png", "black-friday-sale/bf-story-1080x1920.png", "black-friday-sale/make.mjs",
  "promo/teaser.mp4", "promo/jingle.mp3", "decks/q4 plan.pptx", "decks/q4-notes.md", "secrets/.env.json", "secrets/id_rsa.pem",
]) {
  mkdirSync(join(workspace, file, ".."), { recursive: true });
  writeFileSync(join(workspace, file), "x");
}
writeFileSync(join(base, "outside.png"), "x");
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Outside the workspace the rule is the user's File Access setting; pinned here.
const named = (reply: string, reachesOutside = (_: string) => false) => filesNamedInReply(reply, { workspace, reachesOutside });
const paths = (reply: string) => named(reply).map((f) => f.path);

// Live 2026-11-26: a reply said the images were in `workspace/black-friday-sale/`,
// then listed them by name alone. Neither the desktop nor the phone linked any.
describe("filesNamedInReply", () => {
  it("takes each name in a list under the folder line, with its kind", () => {
    const reply = [
      "There are 6 images in `workspace/black-friday-sale/` on the PC.",
      "",
      "- `bf-post-1080x1350.png` : main post",
      "- `bf-story-1080x1920.png` : story version",
    ].join("\n");
    expect(named(reply)).toEqual([
      { path: "/files/black-friday-sale/bf-post-1080x1350.png", name: "bf-post-1080x1350.png", kind: "image" },
      { path: "/files/black-friday-sale/bf-story-1080x1920.png", name: "bf-story-1080x1920.png", kind: "image" },
    ]);
  });

  it("takes a workspace/ path in code or bare, a full path, a markdown link or image, and a /files address", () => {
    expect(paths("Saved `workspace/promo/teaser.mp4` and workspace/promo/jingle.mp3.")).toEqual(["/files/promo/teaser.mp4", "/files/promo/jingle.mp3"]);
    expect(paths(`\`${join(workspace, "black-friday-sale", "bf-post-1080x1350.png")}\``)).toEqual(["/files/black-friday-sale/bf-post-1080x1350.png"]);
    expect(paths("Here is [the deck](workspace/decks/q4 plan.pptx) and ![post](workspace/black-friday-sale/bf-post-1080x1350.png)")).toEqual([
      "/files/decks/q4%20plan.pptx", "/files/black-friday-sale/bf-post-1080x1350.png",
    ]);
    expect(paths("Open http://127.0.0.1:7007/files/decks/q4-notes.md or /files/promo/teaser.mp4")).toEqual(["/files/decks/q4-notes.md", "/files/promo/teaser.mp4"]);
  });

  it("gives a video its kind and every other type the file kind", () => {
    expect(named("`workspace/promo/teaser.mp4` `workspace/promo/jingle.mp3`").map((f) => f.kind)).toEqual(["video", "file"]);
  });

  it("names each file once", () => {
    expect(paths("`workspace/promo/teaser.mp4`, again `workspace/promo/teaser.mp4`")).toEqual(["/files/promo/teaser.mp4"]);
  });

  it("gives a file outside the workspace its /local-files address when a device may open it", () => {
    const outside = join(base, "outside.png");
    expect(named(`\`${outside}\``, () => true)).toEqual([
      { path: "/local-files/" + encodeURIComponent(outside), name: "outside.png", kind: "image" },
    ]);
    expect(named(`\`${outside}\``, () => false)).toEqual([]);
  });

  it("finds none in a reply that names no file", () => {
    expect(named("Starting on it.")).toEqual([]);
  });

  it("leaves a missing file, a script, a credential file, a path outside the workspace, and a name with no folder before it", () => {
    expect(paths("`workspace/promo/gone.png` `workspace/black-friday-sale/make.mjs` `workspace/secrets/id_rsa.pem`")).toEqual([]);
    expect(paths(`\`${join(base, "outside.png")}\` and \`../outside.png\``)).toEqual([]);
    expect(paths("`bf-post-1080x1350.png` is in `workspace/black-friday-sale/`")).toEqual([]);
    expect(paths("Run `npm run build` and see https://example.com/files/a.png")).toEqual([]);
  });
});
