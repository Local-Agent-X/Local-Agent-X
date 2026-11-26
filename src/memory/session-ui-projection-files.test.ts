import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.js";

const ws = vi.hoisted(() => ({ root: "" }));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  workspaceRoot: () => ws.root,
}));

import { projectSessionForUI } from "./session-ui-projection.js";

const base = mkdtempSync(join(tmpdir(), "lax-projection-files-"));
ws.root = join(base, "workspace");
mkdirSync(join(ws.root, "black-friday-sale"), { recursive: true });
writeFileSync(join(ws.root, "black-friday-sale", "bf-post.png"), "x");
afterAll(() => rmSync(base, { recursive: true, force: true }));

// A device reloading a chat draws the files a reply named, as the reply's live
// `done` carried them (workspace/named-files.ts).
describe("projectSessionForUI — a reply's named files", () => {
  it("carries _files on each reply, none when it names none", () => {
    const session = {
      id: "s", title: "", createdAt: 0, updatedAt: 0,
      messages: [
        { role: "user", content: "make the post" },
        { role: "assistant", content: "Done: `workspace/black-friday-sale/bf-post.png`" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "Anytime." },
      ],
    } as unknown as Session;
    const replies = projectSessionForUI(session).messages.filter((m) => m.role === "assistant") as Array<{ _files?: unknown }>;
    expect(replies[0]?._files).toEqual([{ path: "/files/black-friday-sale/bf-post.png", name: "bf-post.png", kind: "image" }]);
    expect(replies[1]?._files).toEqual([]);
  });
});
