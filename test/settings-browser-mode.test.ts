// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  document.body.innerHTML = `
    <select id="cfg-browser-mode">
      <option value="in-app">In-app</option>
      <option value="isolated">Isolated</option>
      <option value="continuity">Continuity</option>
      <option value="advanced-shared">Shared</option>
    </select>
    <div id="browser-mode-status"></div>
    <div id="browser-mode-warning">Warning: every agent session can see and change the same live tabs, cookies, and signed-in state.</div>`;
  const source = readFileSync(join(here, "../public/js/settings-browser-mode.js"), "utf8");
  new Function(`${source}\nwindow.renderBrowserMode = renderBrowserMode;`)();
});

describe("browser identity mode Security UI", () => {
  it("describes in-app mode as the embedded co-drivable browser", () => {
    window.renderBrowserMode("in-app");
    expect(document.getElementById("browser-mode-status")?.textContent).toContain("embedded in-app browser");
    expect(document.getElementById("browser-mode-warning")?.style.display).toBe("none");
  });

  it("falls back to in-app status for an unknown mode", () => {
    window.renderBrowserMode("bogus-mode");
    expect(document.getElementById("cfg-browser-mode") as HTMLSelectElement | null)
      .toBeTruthy();
    expect((document.getElementById("cfg-browser-mode") as HTMLSelectElement).value).toBe("in-app");
    expect(document.getElementById("browser-mode-status")?.textContent).toContain("embedded in-app browser");
  });

  it("describes isolated mode as ephemeral per session", () => {
    window.renderBrowserMode("isolated");
    expect(document.getElementById("browser-mode-status")?.textContent).toContain("separate ephemeral identity");
    expect(document.getElementById("browser-mode-warning")?.style.display).toBe("none");
  });

  it("describes continuity as persistent with one live owner", () => {
    window.renderBrowserMode("continuity");
    expect(document.getElementById("browser-mode-status")?.textContent).toContain("Only one session owns its live context");
  });

  it("shows the prominent warning only for advanced live sharing", () => {
    window.renderBrowserMode("advanced-shared");
    expect(document.getElementById("browser-mode-warning")?.style.display).toBe("");
    expect(document.getElementById("browser-mode-warning")?.textContent).toContain("same live tabs, cookies, and signed-in state");
    const html = readFileSync(join(here, "../public/app.html"), "utf8");
    expect(html).toContain("Your normal browser profile is never used.");
  });
});

declare global {
  interface Window { renderBrowserMode(mode: string): void; }
}
