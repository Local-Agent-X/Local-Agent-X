/**
 * The WS-frame → work-root wiring for App IDE chats.
 *
 * This is the half that was actually missing on Jul 15 2026. The work-root
 * registry, the resolver, and glob's search-base fallback all existed and were
 * unit-green; nothing ever CALLED them for an IDE turn, because the app's
 * identity lived only in an English sentence inside the message body. The agent
 * globbed the repo root and edited LAX's own public/css/app.css.
 *
 * So this suite drives the REAL router with a REAL frame and asserts the
 * session came out anchored. A test that called stampIdeWorkRoot directly would
 * have stayed green through the entire live failure — the helper was never the
 * broken part.
 *
 * Lives in its own file (per the message-router.replay-join.test.ts
 * convention) because it mocks config's workspacePath, which must not bleed
 * into the other router suites.
 */

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { WebSocket } from "ws";

const TMP_WS = realpathSync(mkdtempSync(join(tmpdir(), "lax-ide-router-")));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, workspacePath: (...segs: string[]) => resolve(TMP_WS, ...segs) };
});

const { attachMessageRouter } = await import("./message-router.js");
const { sessionWorkRootOf, clearSessionWorkRoot } = await import("../workspace/paths.js");
const { setChatHandler } = await import("./state.js");

const SESSION = "ide-todo-app";
const APP_DIR = resolve(TMP_WS, "apps", "todo-app");

beforeAll(() => {
  mkdirSync(APP_DIR, { recursive: true });
  // handleChat forwards to the chat handler after stamping. A no-op keeps the
  // frame from starting a real turn while leaving the stamp path intact.
  setChatHandler(() => {});
});

afterEach(() => clearSessionWorkRoot(SESSION));

function makeRouter() {
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: () => {},
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  attachMessageRouter({ ws, subscriptions: new Set<string>() });
  return { dispatch: (obj: unknown) => onMessage!(Buffer.from(JSON.stringify(obj))) };
}

const chatFrame = (extra: Record<string, unknown>) => ({
  type: "chat", sessionId: SESSION, message: "make the background blue", ...extra,
});

describe("chat frame → IDE work root", () => {
  it("an IDE frame's appId anchors the session to the app dir", async () => {
    await makeRouter().dispatch(chatFrame({ appId: "todo-app" }));
    expect(sessionWorkRootOf(SESSION)).toBe(APP_DIR);
  });

  it("a frame with no appId leaves the session unanchored (plain chat is unaffected)", async () => {
    await makeRouter().dispatch(chatFrame({}));
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("a later non-IDE frame clears a previously anchored session", async () => {
    const r = makeRouter();
    await r.dispatch(chatFrame({ appId: "todo-app" }));
    expect(sessionWorkRootOf(SESSION)).toBe(APP_DIR);
    await r.dispatch(chatFrame({}));
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("a traversal appId from a hostile client does not anchor outside the workspace", async () => {
    await makeRouter().dispatch(chatFrame({ appId: "../../.." }));
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("a malformed appId does not throw the frame away — the turn still reaches the handler", async () => {
    let delivered = false;
    setChatHandler(() => { delivered = true; });
    await makeRouter().dispatch(chatFrame({ appId: "../../.." }));
    expect(delivered).toBe(true);
    setChatHandler(() => {});
  });
});
