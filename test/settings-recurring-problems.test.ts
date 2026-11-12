// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/settings-recurring-problems.js"), "utf8");
const page = readFileSync(join(here, "../public/app.html"), "utf8");

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function load(response: unknown): Promise<void> {
  window.apiJson = vi.fn(async () => response) as never;
  new Function(source)();
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="recurring-problems-status"></div>
    <div id="recurring-problems-list"></div>`;
});

describe("recurring problems Memory UI", () => {
  it("is on the Settings page with its script", () => {
    expect(page).toContain('id="recurring-problems-list"');
    expect(page).toContain("/js/settings-recurring-problems.js");
  });

  it("says what failed, how often and where, in plain words", async () => {
    await load({
      windowDays: 14,
      problems: [{
        signature: "abcdef0123456789", tool: "bash", action: null, status: "error", layer: null,
        reason: "python3: command not found", count: 7, sessions: 4, days: 3,
        firstSeen: Date.now() - 5 * 86_400_000, lastSeen: Date.now(),
      }, {
        signature: "0123456789abcdef", tool: "office", action: "read", status: "blocked", layer: "security",
        reason: "outside the workspace", count: 3, sessions: 3, days: 2,
        firstSeen: Date.now() - 2 * 86_400_000, lastSeen: Date.now(),
      }],
      gaps: [],
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("bash: python3: command not found");
    expect(text).toContain("7 times in 4 chats over 3 days");
    expect(text).toContain("Failed");
    expect(text).toContain("office (read): outside the workspace");
    expect(text).toContain("refused by security");
    expect(text).toContain("Refused");
    expect(document.getElementById("recurring-problems-status")?.textContent).toBe("2 recurring failures");
  });

  it("shows what the agent could not do with its own tools", async () => {
    await load({
      windowDays: 14, problems: [],
      gaps: [{ at: Date.now(), summary: "memory_search missed a fact that was in the raw logs", toolsTried: ["memory_search"], workaround: "grep the session logs" }],
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("memory_search missed a fact that was in the raw logs");
    expect(text).toContain("tried memory_search");
    expect(text).toContain("worked around: grep the session logs");
  });

  it("says so when nothing keeps going wrong", async () => {
    await load({ windowDays: 14, problems: [], gaps: [] });
    expect(document.body.textContent).toContain("Nothing keeps going wrong");
  });

  it("offers Keep and Discard on a lesson that is waiting, and saves the answer", async () => {
    const lesson = {
      signature: "abcdef0123456789", tool: "bash", action: null, reason: "python3: command not found",
      lesson: "Use python, not python3, on this computer.", state: "proposed", sessions: 4, reviewedAt: 1, shown: 0, recovered: 0,
    };
    const apiJson = vi.fn(async (path: string, init?: { body?: string }) => {
      if (path.endsWith("/action")) {
        lesson.state = JSON.parse(init!.body!).action === "keep" ? "kept" : "discarded";
        return { lesson };
      }
      return { windowDays: 14, problems: [], lessons: [lesson], gaps: [] };
    });
    window.apiJson = apiJson as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    expect(document.body.textContent).toContain("Use python, not python3, on this computer.");
    expect(document.body.textContent).toContain("for bash: python3: command not found");
    expect(document.body.textContent).toContain("Waiting for you");
    expect(document.getElementById("recurring-problems-status")?.textContent).toBe("1 lesson waiting for you");
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Keep", "Discard"]);

    (document.querySelector("button") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(apiJson).toHaveBeenCalledWith(
      "/api/memory/problems/abcdef0123456789/action",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "keep" }) }),
    );
    expect(document.body.textContent).toContain("In use");
    // A lesson in use can only be discarded.
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Discard"]);
  });

  it("says what the review made of a problem it has looked at", async () => {
    await load({
      windowDays: 14, lessons: [], gaps: [],
      problems: [{
        signature: "0123456789abcdef", tool: "web_fetch", action: null, status: "timeout", layer: null,
        reason: "no answer in 30s", count: 5, sessions: 3, days: 2, firstSeen: Date.now(), lastSeen: Date.now(),
        review: { verdict: "noise", why: "one site that was slow that week" },
      }],
    });
    expect(document.body.textContent).toContain("reviewed: nothing to learn (one site that was slow that week)");
    expect(document.body.textContent).toContain("Timed out");
  });

  it("says it could not load instead of showing an empty list as good news", async () => {
    window.apiJson = vi.fn(async () => { throw new Error("offline"); }) as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();
    expect(document.getElementById("recurring-problems-status")?.textContent).toBe("Could not load");
    expect(document.body.textContent).not.toContain("Nothing keeps going wrong");
  });
});
