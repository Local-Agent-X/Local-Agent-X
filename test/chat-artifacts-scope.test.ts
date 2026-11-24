// @vitest-environment happy-dom
//
// The ARTIFACTS tab opens on the chat on screen (2026-11-22): it asks the
// server for that chat's artifacts, a switch widens it to every chat's, and a
// chat change turns an open tab to the new chat without showing the old
// chat's list under it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const scopeJs = read("chat-agent-feeds-scope.js");
const artifactsJs = read("chat-artifacts.js");
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

interface Tab {
  switchSidePanelTab: (tab: string) => void;
  setArtifactsScope: (scope: string) => void;
  setChat: (id: string | null) => void;
  openArtifact: (filter: string, idx: number) => void;
}

let answers: Array<{ url: string; resolve: (data: unknown) => void }> = [];
const apiJson = vi.fn((url: string) => new Promise((resolve) => { answers.push({ url, resolve }); }));
const item = (name: string, sessionId: string) => ({ type: "file", name, ref: `workspace/${name}`, sessionId, sessionTitle: sessionId, ts: 1 });
async function answer(i: number, artifacts: unknown[]): Promise<void> {
  answers[i].resolve({ artifacts });
  await Promise.resolve(); await Promise.resolve();
}

const openFileLink = vi.fn();

function load(activeId: string | null = "chat-a"): Tab {
  document.body.innerHTML = '<div id="artifacts-tab-body"><div id="artifacts-scope"></div><div id="artifacts-filters"></div><div id="artifacts-list"></div></div>';
  const factory = new Function(
    "document", "apiJson", "esc", "startChat", "openFileLink",
    "var agentFeedsData = {}; var activeChat = startChat ? { id: startChat } : null; var chats = [];\n"
      + scopeJs + "\n" + artifactsJs
      + "\nreturn { switchSidePanelTab, setArtifactsScope, openArtifact,"
      + " setChat: function(id) { activeChat = id ? { id: id } : null; window.laxSidePanelChat.onChatChanged(); } };",
  );
  return factory(document, apiJson, esc, activeId, openFileLink) as Tab;
}

const names = (): string[] => Array.from(document.querySelectorAll(".artifact-name")).map((el) => el.textContent ?? "");
const listText = (): string => document.getElementById("artifacts-list")!.textContent ?? "";

beforeEach(() => { localStorage.clear(); answers = []; apiJson.mockClear(); openFileLink.mockClear(); });

describe("the Artifacts tab is the chat on screen's", () => {
  it("asks for this chat's artifacts when shown", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    expect(apiJson).toHaveBeenCalledWith("/api/artifacts?session=chat-a");
    await answer(0, [item("notes.md", "chat-a")]);
    expect(names()).toEqual(["notes.md"]);
  });

  it("turns to the other chat when it comes on screen, never showing the old list under it", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    await answer(0, [item("notes.md", "chat-a")]);
    tab.setChat("chat-b");
    expect(apiJson).toHaveBeenLastCalledWith("/api/artifacts?session=chat-b");
    expect(listText()).toBe("Loading…");
    await answer(1, []);
    expect(listText()).toBe("No artifacts in this chat yet");
  });

  it("drops an answer for a chat that is no longer on screen", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    tab.setChat("chat-b");
    await answer(0, [item("old-chat.md", "chat-a")]);
    expect(names()).toEqual([]);
    await answer(1, [item("new-chat.md", "chat-b")]);
    expect(names()).toEqual(["new-chat.md"]);
  });

  it("a chat change with the tab closed asks for nothing", () => {
    const tab = load("chat-a");
    tab.setChat("chat-b");
    expect(apiJson).not.toHaveBeenCalled();
  });
});

describe("the This chat / All chats switch", () => {
  it("All asks for every chat's, and is remembered", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    await answer(0, [item("notes.md", "chat-a")]);
    tab.setArtifactsScope("all");
    expect(apiJson).toHaveBeenLastCalledWith("/api/artifacts");
    await answer(1, [item("notes.md", "chat-a"), item("plan.md", "chat-b")]);
    expect(names()).toEqual(["notes.md", "plan.md"]);
    expect(document.querySelector('#artifacts-scope button[aria-pressed="true"]')?.textContent).toBe("All chats");
    expect(localStorage.getItem("lax_artifacts_scope")).toBe("all");
    // On All, another chat coming on screen changes nothing to ask for.
    apiJson.mockClear();
    tab.setChat("chat-b");
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("with no chat open, lists every chat's", () => {
    const tab = load(null);
    tab.switchSidePanelTab("artifacts");
    expect(apiJson).toHaveBeenCalledWith("/api/artifacts");
  });
});

// A file the agent made is listed by the path its tool was given
// ("workspace/LAX-Pitch-Deck.pptx"). The panel opened only /files/ refs, so the
// row copied that path to nowhere (2026-11-23); the server now sends the file's
// /files/ address as openUrl, and the row opens it like a chat link.
describe("clicking a file row", () => {
  it("opens a workspace file at the /files/ address the server resolved", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    await answer(0, [{ ...item("LAX-Pitch-Deck.pptx", "chat-a"), openUrl: "/files/LAX-Pitch-Deck.pptx" }]);
    tab.openArtifact("all", 0);
    expect(openFileLink).toHaveBeenCalledWith("/files/LAX-Pitch-Deck.pptx");
  });

  it("a /files/ ref still opens as itself", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    await answer(0, [{ type: "file", name: "a.docx", ref: "/files/a.docx", sessionId: "chat-a", sessionTitle: "chat-a", ts: 1 }]);
    tab.openArtifact("all", 0);
    expect(openFileLink).toHaveBeenCalledWith("/files/a.docx");
  });

  it("a served-media openUrl is never taken for a workspace file", async () => {
    const tab = load("chat-a");
    tab.switchSidePanelTab("artifacts");
    await answer(0, [{ ...item("hosts", "chat-a"), ref: "/etc/hosts", openUrl: undefined }]);
    tab.openArtifact("all", 0);
    expect(openFileLink).not.toHaveBeenCalled();
  });
});
