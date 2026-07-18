// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/settings-learned-workflows.js"), "utf8");
const inspectorSource = readFileSync(join(here, "../public/js/memory-brain/inspector.js"), "utf8");
const wsSource = readFileSync(join(here, "../public/js/chat-ws-handler.js"), "utf8");

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="learned-workflows-status"></div>
    <div id="learned-workflows-list"></div>`;
  window.MemoryBrain = { openLearningInspector: vi.fn() } as never;
});

describe("learned workflows Memory UI", () => {
  it("shows assisted review controls and opens detail in the existing inspector", async () => {
    window.apiJson = vi.fn(async (path: string) => {
      if (path.endsWith("/candidate-1")) return { item: { id: "candidate-1", name: "Ship safely", state: "candidate", versions: [] } };
      return { mode: "assisted", items: [{ id: "candidate-1", name: "Ship safely", state: "candidate", confidence: 0.91, versionCount: 1 }] };
    }) as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    expect(document.body.textContent).toContain("Ship safely");
    expect(document.body.textContent).toContain("Activate");
    expect(document.body.textContent).toContain("Reject");
    (document.querySelector(".learned-workflow-name") as HTMLElement).click();
    await flush();
    expect(window.MemoryBrain.openLearningInspector).toHaveBeenCalledOnce();
  });

  it("keeps autonomous candidates quiet without approval controls", async () => {
    window.apiJson = vi.fn(async () => ({
      mode: "autonomous",
      items: [{ id: "candidate-2", name: "Prepare release", state: "candidate", confidence: 0.88, versionCount: 1 }],
    })) as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    expect(document.getElementById("learned-workflows-status")?.textContent).toBe("Learning automatically");
    expect(document.body.textContent).toContain("qualifying quietly");
    expect(document.body.textContent).not.toContain("Activate");
    expect(document.body.textContent).not.toContain("Reject");
  });

  it("restores the previous row when an optimistic action fails", async () => {
    window.apiJson = vi.fn(async (_path: string, options?: { method?: string }) => {
      if (options?.method === "POST") throw new Error("save failed");
      return { mode: "assisted", items: [{ id: "active-1", name: "Review patch", state: "active", confidence: 0.93, activeVersionId: "v2", versionCount: 2 }] };
    }) as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    (Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Archive") as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector(".learned-workflow-state")?.textContent).toBe("active");
    expect(document.getElementById("learned-workflows-status")?.textContent).toContain("restored previous state");
  });

  it("exposes lifecycle controls and refreshes from the learning event", async () => {
    window.apiJson = vi.fn(async () => ({
      mode: "assisted",
      items: [
        { id: "active-2", name: "Active flow", state: "versioned", confidence: 0.9, versionCount: 2 },
        { id: "archived-1", name: "Old flow", state: "archived", confidence: 0.8, versionCount: 1 },
      ],
    })) as never;
    new Function(source)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    expect(document.body.textContent).toContain("Archive");
    expect(document.body.textContent).toContain("Restore");
    expect(inspectorSource).toContain("rollback.onclick");
    expect(wsSource).toContain("msg.type === 'learning_changed'");
    expect(wsSource).toContain("window.refreshLearnedWorkflows()");
  });
});

declare global {
  interface Window {
    apiJson(path: string, options?: unknown): Promise<unknown>;
    MemoryBrain: { openLearningInspector: ReturnType<typeof vi.fn> };
  }
}
