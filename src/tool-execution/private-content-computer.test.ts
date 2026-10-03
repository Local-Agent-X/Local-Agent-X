// Where a `computer` keystroke lands and what a paste carries, read without a
// generated script: the focused window comes from the computer tool's own
// native input library, and a clipboard that cannot be read (clipboard_read
// has no PowerShell to run on a Mac) is unknown content the user is asked
// about, never an empty paste. What is typed or pasted is read from the
// arguments the action runs with, so text nested under `params` is judged too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerPayload, isPasteChord, queryForegroundApp, readClipboardText, UnreadableClipboardError } from "./private-content-computer.js";
import { clipboardTools } from "../tools/clipboard-tools.js";
import { computerTool } from "../tools/input-tools.js";
import { ctx, readEmail, STATEMENT, useIsolatedSession, verdict } from "./private-content.test-helper.js";

const nut = vi.hoisted(() => ({ getActiveWindow: vi.fn() }));
vi.mock("@nut-tree-fork/nut-js", () => nut);
const driver = vi.hoisted(() => ({ typeText: vi.fn(), pressKeys: vi.fn() }));
vi.mock("../tools/input-driver.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../tools/input-driver.js")>()), ...driver }));

useIsolatedSession();

const REAL_PLATFORM = process.platform;
const setPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, "platform", { value }); };

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  nut.getActiveWindow.mockReset();
  vi.restoreAllMocks();
});

const clipboardRead = clipboardTools.find((t) => t.name === "clipboard_read")!;
const NO_POWERSHELL = { content: "Clipboard read failed: spawn powershell ENOENT", isError: true };

describe("the window a keystroke lands in, on Windows", () => {
  it("is read through the input library's native addon and named as a window by its title", async () => {
    setPlatform("win32");
    nut.getActiveWindow.mockResolvedValue({ title: Promise.resolve("Apply - Acme Careers - Google Chrome") });
    expect(await queryForegroundApp()).toEqual({ name: "the window", title: "Apply - Acme Careers - Google Chrome" });
    expect(nut.getActiveWindow).toHaveBeenCalledTimes(1);
  });

  it("a window with no title, or an addon that cannot read one, is no named destination", async () => {
    setPlatform("win32");
    nut.getActiveWindow.mockResolvedValue({ title: Promise.resolve("") });
    expect(await queryForegroundApp()).toBeNull();
    nut.getActiveWindow.mockRejectedValue(new Error("libnut failed to load"));
    expect(await queryForegroundApp()).toBeNull();
  });
});

describe("the clipboard a paste chord sends", () => {
  it("is the text clipboard_read returns; a failed read throws rather than reading as empty", async () => {
    vi.spyOn(clipboardRead, "execute").mockResolvedValue({ content: "a grocery list" });
    expect(await readClipboardText()).toBe("a grocery list");
    vi.spyOn(clipboardRead, "execute").mockResolvedValue(NO_POWERSHELL);
    await expect(readClipboardText()).rejects.toBeInstanceOf(UnreadableClipboardError);
  });

  it("unreadable after a private read: asked about as unknown content, for this call only", async () => {
    const execute = vi.spyOn(clipboardRead, "execute").mockResolvedValue(NO_POWERSHELL);
    const notes = { foregroundApp: async () => ({ name: "Notes", title: "" }), clipboardText: readClipboardText };
    const paste = () => ctx("computer", { action: "press", keys: ["cmd", "v"] });

    expect(await verdict(paste(), notes)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled(); // nothing private read yet: the clipboard is not even looked at

    readEmail();
    const reason = await verdict(paste(), notes);
    expect(reason).toMatch(/send text from the clipboard \(the check could not read it\) to Notes/);
    expect(reason).toMatch(/a yes covers this call only/);
    expect(await verdict(ctx("computer", { action: "type", text: "hello" }), notes)).toBeUndefined();
  });
});

describe("a call that nests its arguments under params", () => {
  const app = { foregroundApp: async () => ({ name: "chrome", title: "Apply now - Acme Careers" }) };

  it("typing private text nested under params is asked about, even beside a harmless flat text", async () => {
    readEmail();
    expect(await verdict(ctx("computer", { action: "type", params: { text: STATEMENT } }), app)).toMatch(/to chrome/);
    expect(await verdict(ctx("computer", { action: "type", text: "hello", params: { text: [STATEMENT] } }), app)).toMatch(/to chrome/);
  });

  it("a paste chord nested under params sends the clipboard", async () => {
    readEmail();
    const deps = { ...app, clipboardText: async () => `copied: ${STATEMENT}` };
    expect(await verdict(ctx("computer", { action: "press", params: { keys: ["ctrl", "v"] } }), deps)).toMatch(/to chrome/);
  });

  it("is judged by the text the action types and the chord it presses, whatever the flat fields say", async () => {
    const calls: Record<string, unknown>[] = [
      { action: "type", text: "flat" },
      { action: "type", params: { text: "nested" } },
      { action: "type", text: "shown", params: { text: "typed" } },
      { action: "type", params: { text: ["listed"] } },
      { action: "press", params: { keys: ["ctrl", "v"] } },
      { action: "press", keys: ["ctrl", "s"], params: { keys: ["shift", "insert"] } },
      { action: "press", keys: ["ctrl", "v"], params: { keys: ["ctrl", "s"] } },
    ];
    for (const args of calls) {
      driver.typeText.mockClear();
      driver.pressKeys.mockClear();
      await computerTool.execute(args);
      const typed: string = driver.typeText.mock.calls[0]?.[0] ?? "";
      const pasted = isPasteChord(driver.pressKeys.mock.calls[0]?.[0]) ? "the clipboard" : "";
      expect(await computerPayload(args, async () => "the clipboard"), JSON.stringify(args)).toBe(typed || pasted);
    }
  });
});
