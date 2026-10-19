// @vitest-environment happy-dom
// Settings → Security's Windows network cage buttons: Install whenever an
// install can run (a removed cage keeps its helper), Repair whenever an
// installed cage fails its check, and no dead end when the helper is gone.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
const posted: string[] = [];

beforeEach(() => {
  document.body.innerHTML = `
    <div id="sandbox-windows-cage" style="display:none">
      <div id="sandbox-windows-cage-detail"></div>
      <button id="sandbox-windows-cage-install"></button>
      <button id="sandbox-windows-cage-repair"></button>
      <button id="sandbox-windows-cage-uninstall"></button>
    </div>`;
  posted.length = 0;
  (window as unknown as { apiFetch: (path: string, init: { body: string }) => Promise<unknown> }).apiFetch = async (_path, init) => {
    posted.push(JSON.parse(init.body).action);
    return { ok: true, json: async () => ({}) };
  };
  const source = readFileSync(join(here, "../public/js/settings-sandbox.js"), "utf8");
  new Function(`${source}
window.renderWindowsCage = renderWindowsCage;
window.repairWindowsCage = repairWindowsCage;
renderSandboxStatus = () => {}; scheduleSandboxRecheck = () => {}; loadSandboxMode = async () => {};`)();
});

const shown = (action: string) => document.getElementById(`sandbox-windows-cage-${action}`)!.style.display !== "none";
const detail = () => document.getElementById("sandbox-windows-cage-detail")!.textContent ?? "";

describe("Settings → Security: the Windows network cage", () => {
  it("a removed cage whose helper was kept offers Install, and nothing else", () => {
    window.renderWindowsCage({ helper: HELPER, installed: false, installable: true, detail: "Not installed." });
    expect([shown("install"), shown("repair"), shown("uninstall")]).toEqual([true, false, false]);
  });

  it("with no helper on the computer there is no button to press, and the detail says to re-run the installer", () => {
    window.renderWindowsCage({ helper: null, installed: false, installable: false, detail: "Not installed, and the cage's helper is not on this computer. Re-run the Local Agent X installer to add the Windows network cage." });
    expect([shown("install"), shown("repair"), shown("uninstall")]).toEqual([false, false, false]);
    expect(detail()).toMatch(/Re-run the Local Agent X installer/);
  });

  it("an installed cage whose permit names the old range offers Repair, naming both ranges", () => {
    window.renderWindowsCage({ helper: HELPER, installed: true, installable: true, detail: "Installed.", permitMismatch: { installed: "60090-60099", proxy: "47090-47099" } });
    expect([shown("install"), shown("repair"), shown("uninstall")]).toEqual([false, true, true]);
    expect(detail()).toContain("60090-60099");
    expect(detail()).toContain("47090-47099");
  });

  it("an installed cage that fails its check offers Repair even when the permit cannot be read", () => {
    window.renderWindowsCage({ helper: HELPER, installed: true, installable: true, detail: "Installed.", proofFailure: "loopback is not reachable from the cage" });
    expect(shown("repair")).toBe(true);
    expect(detail()).toContain("installed but not working");
  });

  it("a working cage offers only Remove", () => {
    window.renderWindowsCage({ helper: HELPER, installed: true, installable: true, detail: "Installed." });
    expect([shown("install"), shown("repair"), shown("uninstall")]).toEqual([false, false, true]);
  });

  it("Repair asks the server for a repair", async () => {
    window.renderWindowsCage({ helper: HELPER, installed: true, installable: true, detail: "Installed.", proofFailure: "x" });
    await window.repairWindowsCage();
    expect(posted).toEqual(["repair"]);
  });
});

declare global {
  interface Window {
    renderWindowsCage: (cage: Record<string, unknown> | null) => void;
    repairWindowsCage: () => Promise<void>;
  }
}
