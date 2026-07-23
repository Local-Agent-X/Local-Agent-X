// servedFileHint direction regression. The hint must point the model the
// RIGHT way per file class: app frontend source is live immediately (HMR /
// static auto-reload) so the hint forbids restart+re-verify; app server/
// source and generic served files keep the "OLD code until restart" nudge.
// The old undirected hint told the model to restart after frontend edits
// that were already live — it obediently restarted and re-verified a done
// change (and on the installed app that restart can hang).

import { describe, it, expect } from "vitest";
import { appIdFromPath, servedFileHint, type ServedFileHintDeps } from "./file-hints.js";

const APP_FRONTEND = "C:\\Users\\x\\.lax\\workspace\\apps\\todo\\index.html";
const APP_SRC = "C:\\Users\\x\\.lax\\workspace\\apps\\todo\\src\\Sidebar.tsx";
const APP_SERVER = "C:\\Users\\x\\.lax\\workspace\\apps\\todo\\server\\app.js";
const PLAIN = "C:\\Users\\x\\projects\\misc\\notes.js";

const LIVE_SESSION = [{ sessionId: "s1", command: "npm run dev" }];

function deps(over: ServedFileHintDeps = {}): ServedFileHintDeps {
  return {
    sessionsForPath: () => [],
    devServerRecord: () => null,
    ...over,
  };
}

describe("appIdFromPath", () => {
  it("extracts the app id from an installed-app path (either separator)", () => {
    expect(appIdFromPath(APP_FRONTEND)).toBe("todo");
    expect(appIdFromPath("/home/x/.lax/workspace/apps/todo/index.html")).toBe("todo");
    expect(appIdFromPath(PLAIN)).toBeNull();
  });
});

describe("servedFileHint — app frontend source (the over-eager-restart regression)", () => {
  it("says the change is already live and forbids restart/re-verify, even with a live dev-server session", () => {
    const hint = servedFileHint(APP_FRONTEND, deps({
      sessionsForPath: () => LIVE_SESSION,
      devServerRecord: () => ({ appId: "todo", command: "npm run dev", cwd: "", port: 5173, connector: "dev-todo", kind: "frontend" }),
    }));
    expect(hint).toMatch(/already live/);
    expect(hint).toMatch(/Do NOT restart/);
    expect(hint).not.toMatch(/process_restart/);
    expect(hint).not.toMatch(/OLD code/);
  });

  it("same for framework src/ files of a static app with no dev-server record", () => {
    const hint = servedFileHint(APP_SRC, deps({ sessionsForPath: () => LIVE_SESSION }));
    expect(hint).toMatch(/already live/);
    expect(hint).not.toMatch(/process_restart/);
  });
});

describe("servedFileHint — app server/ source keeps the restart nudge", () => {
  it("points at app_serve_backend when a backend dev-server record exists", () => {
    const hint = servedFileHint(APP_SERVER, deps({
      devServerRecord: () => ({ appId: "todo", command: "cd server && npm run dev", cwd: "", port: 3001, connector: "dev-todo", kind: "backend" }),
    }));
    expect(hint).toMatch(/BACKEND source/);
    expect(hint).toMatch(/OLD code/);
    expect(hint).toMatch(/app_serve_backend/);
  });

  it("points at process_restart when only a live session serves it", () => {
    const hint = servedFileHint(APP_SERVER, deps({ sessionsForPath: () => LIVE_SESSION }));
    expect(hint).toMatch(/OLD code/);
    expect(hint).toMatch(/process_restart/);
    expect(hint).toContain("s1");
  });

  it("stays silent when nothing is running (no stale server to warn about)", () => {
    expect(servedFileHint(APP_SERVER, deps())).toBe("");
  });
});

describe("servedFileHint — non-app files keep the original behavior", () => {
  it("warns about the live session serving the file", () => {
    const hint = servedFileHint(PLAIN, deps({ sessionsForPath: () => LIVE_SESSION }));
    expect(hint).toMatch(/may be serving this file/);
    expect(hint).toMatch(/process_restart/);
    expect(hint).toContain("s1");
  });

  it("is empty with no matching session", () => {
    expect(servedFileHint(PLAIN, deps())).toBe("");
  });
});
