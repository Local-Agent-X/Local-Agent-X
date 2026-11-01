// @vitest-environment happy-dom
//
// A shell approval card shows the whole command, never a cut: on a long
// command the `rm -rf` the card warned about used to sit past the 150
// characters the line showed (2026-10-31). The settled record keeps the
// command too, so the audit line says what was approved or denied.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const previewJs = readFileSync(join(here, "../public/js/chat-render-shell-preview.js"), "utf8");
const approvalsJs = readFileSync(join(here, "../public/js/chat-render-approvals.js"), "utf8");
const css = readFileSync(join(here, "../public/css/app.css"), "utf8");

type Apply = (card: HTMLElement, preview: unknown) => void;
type Record = (ap: Record<string, unknown>) => HTMLElement;

const applyShellPreview = new Function(`${previewJs}\nreturn applyShellPreview;`)() as Apply;
const makeApprovalRecord = new Function(`${approvalsJs}\nreturn makeApprovalRecord;`)() as Record;

const long = 'mkdir -p "$W/app" && cd "$W/app" && npm pack three@0.170.0 --silent 2>&1 | tail -1 && tar -xzf three-0.170.0.tgz package/build/three.module.js && mv package/build/three.module.js ./three.module.js && rm -rf package three-0.170.0.tgz && ls -la';
const preview = { kind: "shell", cmd: long, cwd: "C:\\Users\\me\\apps" };

function card(): HTMLElement {
  const el = document.createElement("div");
  el.className = "approval-card";
  el.innerHTML = '<div class="approval-title">Approval needed: bash</div><div class="approval-context">⚠ Cannot be undone — …</div><div class="approval-actions"><button>Approve</button></div>';
  return el;
}

describe("the command on a shell approval card", () => {
  it("is shown whole, under the card's line and above the buttons", () => {
    const el = card();
    applyShellPreview(el, preview);
    const block = el.querySelector(".shell-preview")!;
    expect(block.previousElementSibling?.className).toBe("approval-context");
    expect(block.nextElementSibling?.className).toBe("approval-actions");
    expect(el.querySelector(".shell-preview-command")?.textContent).toBe(long);
    expect(el.querySelector(".shell-preview-cwd")?.textContent).toBe("Runs in C:\\Users\\me\\apps");
  });

  it("has no scroll box to hide the end of the command in", () => {
    const rule = css.match(/\.shell-preview-command\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toMatch(/max-height|overflow(?!-wrap)/);
    expect(rule).toContain("white-space:pre-wrap");
  });

  it("is set as text, never parsed as markup", () => {
    const el = card();
    applyShellPreview(el, { ...preview, cmd: 'echo "<img src=x onerror=alert(1)>"' });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".shell-preview-command")?.textContent).toContain("<img");
  });

  it("is left off a card whose ask is not a shell command", () => {
    const el = card();
    applyShellPreview(el, { kind: "file", path: "a.md", diff: "", lineCount: { added: 0, removed: 0 }, truncated: false });
    expect(el.querySelector(".shell-preview")).toBeNull();
  });
});

describe("the settled record of a shell ask", () => {
  it("keeps the command beside the outcome", () => {
    const rec = makeApprovalRecord({ id: "apr-1", toolName: "bash", context: "Your security profile asks before a command like this runs.", status: "denied", preview });
    expect(rec.querySelector(".approval-record-command")?.textContent).toBe(long);
    expect(rec.querySelector(".approval-record-outcome")?.textContent).toContain("nothing ran");
  });
});
