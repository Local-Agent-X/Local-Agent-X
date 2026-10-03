import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { createPageTool } from "./create-page-tool.js";
import { CAN_CREATE_DIRECTORY_LINK } from "../symlink-capabilities.test-helper.js";

// create_page used to write <install>/public/<name>.html: inside the install
// the agent may not modify, able to replace the app's own UI (name "app"), and
// served with the user's login token. It now writes a workspace app.

let base: string;
let ws: string;
let saved: LAXConfig;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "lax-create-page-")));
  ws = join(base, "workspace");
  mkdirSync(ws);
  saved = getRuntimeConfig();
  setRuntimeConfig({ ...saved, workspace: ws });
});
afterEach(() => {
  setRuntimeConfig(saved);
  rmSync(base, { recursive: true, force: true });
});

const page = (name: string, content = "<h1>hi</h1>") => createPageTool.execute({ name, title: "T", content });

describe("create_page", () => {
  it("writes the page as a workspace app, even under the name of the app's own UI", async () => {
    const r = await page("app");
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("/apps/app/");
    const html = readFileSync(join(ws, "apps", "app", "index.html"), "utf-8");
    expect(html).toContain("<h1>hi</h1>");
    expect(html).not.toContain("lax_token");
  });

  it("replaces its own page but not an app it did not make", async () => {
    await page("dash", "<p>one</p>");
    expect((await page("dash", "<p>two</p>")).isError).toBeFalsy();
    expect(readFileSync(join(ws, "apps", "dash", "index.html"), "utf-8")).toContain("<p>two</p>");

    mkdirSync(join(ws, "apps", "built"), { recursive: true });
    writeFileSync(join(ws, "apps", "built", "index.html"), "user app\n");
    const r = await page("built");
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("already exists");
    expect(readFileSync(join(ws, "apps", "built", "index.html"), "utf-8")).toBe("user app\n");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("refuses a link planted at apps/<name> that leads out of the workspace", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(ws, "apps"));
    symlinkSync(outside, join(ws, "apps", "evil"), process.platform === "win32" ? "junction" : "dir");
    const r = await page("evil");
    expect(r.isError).toBe(true);
    expect(existsSync(join(outside, "index.html"))).toBe(false);
  });
});
