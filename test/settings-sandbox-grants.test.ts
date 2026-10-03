// @vitest-environment happy-dom
// Settings → Security on a Windows cage that is proven and in use but whose
// sandbox user's grants are still being made or have failed: shell commands
// wait or are refused, so the section must not read as a working guarded cage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const GRANT_FAILURE = "The Windows shell cage could not give its sandbox user access to the workspace and the shell's own files (the helper exited with 5: Access is denied.), so it cannot run commands. Remove and reinstall the Windows network cage in Settings → Security to try again; restarting the app also retries it.";
const PROVEN = { selectedMode: "guarded", effectiveMode: "guarded", mode: "guarded", confined: true, proofPending: false, guardedAvailable: true, dockerAvailable: false };
const CAGE = { helper: "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe", installed: true, detail: "Installed.", proofPending: false };

let reads = 0;
let payload: Record<string, unknown> = {};

beforeEach(() => {
  document.body.innerHTML = `
    <select id="cfg-sandbox-mode"><option value="host">Host</option><option value="guarded">Protected</option><option value="docker">Maximum</option></select>
    <div id="sandbox-hint"></div>
    <div id="sandbox-effective-status" class="status-badge warn"></div>
    <div id="sandbox-effective-detail"></div>
    <div id="sandbox-host-ack-actions"><button id="sandbox-ack-btn"></button><button id="sandbox-revoke-btn"></button></div>
    <div id="sandbox-windows-cage" style="display:none">
      <div id="sandbox-windows-cage-detail"></div>
      <button id="sandbox-windows-cage-install"></button><button id="sandbox-windows-cage-uninstall"></button>
    </div>`;
  reads = 0;
  (window as unknown as { apiFetch: () => Promise<{ ok: boolean; json: () => Promise<unknown> }> }).apiFetch = async () => {
    reads++;
    return { ok: true, json: async () => payload };
  };
  const source = readFileSync(join(here, "../public/js/settings-sandbox.js"), "utf8");
  new Function(`${source}\nwindow.renderSandboxStatus = renderSandboxStatus;\nwindow.loadSandboxMode = loadSandboxMode;`)();
});
afterEach(() => { vi.useRealTimers(); });

const badge = () => document.getElementById("sandbox-effective-status")!;
const detail = () => document.getElementById("sandbox-effective-detail")!.textContent;

describe("Settings → Security: the Windows cage's grants", () => {
  it("a failed grant reads as refused, with the reason and the next step", () => {
    window.renderSandboxStatus({ ...PROVEN, windowsCage: { ...CAGE, grantFailure: GRANT_FAILURE } });
    expect(badge().className).toBe("status-badge err");
    expect(badge().textContent).toContain("Effective: guarded, but shell commands are refused");
    expect(detail()).toBe(GRANT_FAILURE);
    expect(detail()).toContain("Remove and reinstall the Windows network cage");
  });

  it("grants still being made read as preparing, not as ready", () => {
    window.renderSandboxStatus({ ...PROVEN, windowsCage: { ...CAGE, grantPending: true } });
    expect(badge().className).toBe("status-badge warn");
    expect(badge().textContent).toContain("Preparing the Windows cage");
    expect(detail()).toMatch(/none runs outside the cage/);
  });

  it("grants made read as the working guarded cage", () => {
    window.renderSandboxStatus({ ...PROVEN, windowsCage: CAGE });
    expect(badge().className).toBe("status-badge ok");
    expect(badge().textContent).toContain("Effective: guarded confined");
  });

  it("while the grants are being made the section re-reads the status, so a failure shows without a reload", async () => {
    vi.useFakeTimers();
    payload = { ...PROVEN, windowsCage: { ...CAGE, grantPending: true } };
    await window.loadSandboxMode();
    expect(reads).toBe(1);
    payload = { ...PROVEN, windowsCage: { ...CAGE, grantFailure: GRANT_FAILURE } };
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(2);
    expect(detail()).toBe(GRANT_FAILURE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(2);
  });
});

declare global {
  interface Window {
    renderSandboxStatus(d: Record<string, unknown>): void;
    loadSandboxMode(): Promise<void>;
  }
}
