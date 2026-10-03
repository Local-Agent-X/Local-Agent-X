import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unsafeWorkspaceReason } from "./workspace-location.js";
import { loadConfig } from "../config.js";
import { platformRoot } from "../platform-root.js";

describe("unsafeWorkspaceReason", () => {
  let base = "";
  let home = "";
  let install = "";
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "ws-location-"));
    home = join(base, "Users", "me");
    install = join(home, "AppData", "Local", "Programs", "local-agent-x");
    for (const d of [join(install, "src"), join(install, "workspace", "apps"), join(home, "Documents")]) mkdirSync(d, { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const reason = (ws: string) => unsafeWorkspaceReason(ws, install, home);

  it("refuses the home folder and every folder above it", () => {
    for (const ws of [home, dirname(home), base]) expect(reason(ws), ws).toMatch(/contains the home folder/);
  });

  it("refuses the install folder, a folder around it, and a folder of the engine", () => {
    expect(reason(install)).toMatch(/contains the folder Local Agent X is installed in/);
    expect(reason(dirname(install))).toMatch(/contains the folder Local Agent X is installed in/);
    expect(reason(join(install, "src"))).toMatch(/is inside the folder Local Agent X is installed in/);
    expect(reason(join(install, "config"))).toMatch(/is inside the folder Local Agent X is installed in/);
  });

  it("accepts the install's own workspace folder and anything under it", () => {
    expect(reason(join(install, "workspace"))).toBeNull();
    expect(reason(join(install, "workspace", "apps"))).toBeNull();
  });

  it("accepts an ordinary folder, including one that does not exist yet", () => {
    expect(reason(join(home, "Documents", "Local Agent X", "workspace"))).toBeNull();
    expect(reason(join(base, "D", "work"))).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("refuses the same folders by another casing", () => {
    expect(reason(home.toUpperCase())).toMatch(/contains the home folder/);
    expect(reason(join(install, "SRC"))).toMatch(/is inside the folder/);
  });

  // Windows ships such a link (C:\Documents and Settings -> C:\Users), and a
  // path through one names a folder no lexical comparison can match.
  describe("through a link to the Users folder", () => {
    let alias = "";
    beforeAll(() => {
      alias = join(base, "Documents and Settings");
      symlinkSync(join(base, "Users"), alias, process.platform === "win32" ? "junction" : "dir");
    });

    it("refuses the home folder spelled through the link, either side", () => {
      expect(reason(join(alias, "me"))).toMatch(/contains the home folder/);
      expect(unsafeWorkspaceReason(home, install, join(alias, "me"))).toMatch(/contains the home folder/);
    });

    it("refuses a folder of the engine spelled through the link, either side", () => {
      const viaAlias = join(alias, "me", "AppData", "Local", "Programs", "local-agent-x");
      expect(reason(join(viaAlias, "src"))).toMatch(/is inside the folder Local Agent X is installed in/);
      expect(unsafeWorkspaceReason(join(install, "src"), viaAlias, home)).toMatch(/is inside the folder Local Agent X is installed in/);
    });
  });
});

// The load path: a refused workspace in config.json is ignored at start, the
// default takes its place on disk, and nothing is moved. Qualification boot
// keeps loadConfig from relinking or migrating this checkout's workspace.
describe("loadConfig ignores a workspace no write zone may have", () => {
  let dataDir = "";
  const saved: Record<string, string | undefined> = {};
  const ENV = ["LAX_DATA_DIR", "LAX_WORKSPACE", "LAX_DOCUMENTS_DIR", "LAX_LOCAL_MODEL_QUALIFICATION_BOOT"];

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    dataDir = mkdtempSync(join(tmpdir(), "ws-location-config-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT = "1";
    delete process.env.LAX_WORKSPACE;
  });
  afterEach(() => { delete process.env.LAX_DOCUMENTS_DIR; delete process.env.LAX_WORKSPACE; });
  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  const configPath = () => join(dataDir, "config.json");
  const writeWorkspace = (workspace: string) =>
    writeFileSync(configPath(), JSON.stringify({ authToken: "t", sandboxModeMigrated: true, browserMode: "in-app", workspace }));
  const persisted = () => JSON.parse(readFileSync(configPath(), "utf-8")).workspace;

  it.each([
    ["the home folder", () => homedir()],
    ["a folder of the engine", () => join(platformRoot(), "src")],
  ])("falls back to the default for %s", (_label, location) => {
    writeWorkspace(location());
    expect(loadConfig().workspace).toBe("./workspace");
    expect(persisted()).toBe("./workspace");
  });

  it("falls back to the Documents workspace where the app keeps one", () => {
    const docs = mkdtempSync(join(tmpdir(), "ws-location-docs-"));
    process.env.LAX_DOCUMENTS_DIR = docs;
    writeWorkspace(homedir());
    expect(loadConfig().workspace).toBe(join(docs, "Local Agent X", "workspace"));
    rmSync(docs, { recursive: true, force: true });
  });

  it("keeps an ordinary workspace", () => {
    const ws = join(dataDir, "mine");
    writeWorkspace(ws);
    expect(loadConfig().workspace).toBe(ws);
    expect(persisted()).toBe(ws);
  });

  it("ignores a refused LAX_WORKSPACE without writing over the saved value", () => {
    const ws = join(dataDir, "saved");
    writeWorkspace(ws);
    process.env.LAX_WORKSPACE = homedir();
    expect(loadConfig().workspace).toBe("./workspace");
    expect(persisted()).toBe(ws);
  });
});
