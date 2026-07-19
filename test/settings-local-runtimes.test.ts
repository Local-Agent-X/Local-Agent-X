import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(join(process.cwd(), "public/js/settings-local-runtimes.js"), "utf8");

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadUi(options: {
  apiJson?: () => Promise<unknown>;
  apiPost?: (path: string, body: unknown) => Promise<unknown>;
  list?: Record<string, unknown>;
} = {}) {
  const listeners: Array<(event: unknown) => void> = [];
  const list = options.list ?? {
    dataset: {},
    innerHTML: "",
    addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.push(listener),
  };
  const document = { getElementById: (id: string) => id === "local-runtimes-list" ? list : null };
  const factory = new Function(
    "document", "apiJson", "apiPost", "apiFetch", "esc", "window",
    `${source}; return { loadLocalRuntimesEditor, verifyLocalRuntime, localCertificationResultHtml };`,
  );
  return {
    list,
    listeners,
    ui: factory(
      document,
      options.apiJson ?? (async () => ({ manual: [], runtimes: [] })),
      options.apiPost ?? (async () => ({ ok: true })),
      async () => ({ ok: true }),
      escapeHtml,
      {},
    ) as {
      loadLocalRuntimesEditor: () => Promise<void>;
      verifyLocalRuntime: (button: unknown) => Promise<void>;
      localCertificationResultHtml: (result: unknown) => string;
    },
  };
}

describe("local-runtime settings verification UI", () => {
  it("always renders automatic discoveries while preserving manual empty state", async () => {
    const { ui, list, listeners } = loadUi({
      apiJson: async () => ({
        manual: [],
        runtimes: [{
          id: "ollama@127.0.0.1:11434",
          label: "Ollama",
          endpoint: { baseUrl: "http://127.0.0.1:11434" },
          models: [{
            id: "model-a", contextWindow: 8192, tools: true,
            certification: { status: "unverified" },
          }],
        }],
      }),
    });
    await ui.loadLocalRuntimesEditor();
    await ui.loadLocalRuntimesEditor();

    expect(listeners).toHaveLength(1);
    expect(String(list.innerHTML)).toContain("DISCOVERED");
    expect(String(list.innerHTML)).toContain("model-a");
    expect(String(list.innerHTML)).toContain(">Verify<");
    expect(String(list.innerHTML)).toContain("No manual runtimes yet");
    expect(source).not.toMatch(/showModal|<dialog|createElement\(['"]dialog/);
  });

  it("keeps one inline progress/result surface and posts only runtimeId plus model", async () => {
    let release!: (value: unknown) => void;
    const apiPost = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { ui } = loadUi({ apiPost });
    const resultEl = { style: { display: "none" }, innerHTML: "" };
    const badge = { className: "status-badge", innerHTML: "" };
    const row = { querySelector: (selector: string) => selector.includes("result") ? resultEl : badge };
    const attrs: Record<string, string> = {
      "data-lr-runtime": encodeURIComponent("runtime-b"),
      "data-lr-model": encodeURIComponent("shared-model"),
    };
    const button = {
      disabled: false,
      textContent: "Verify",
      closest: () => row,
      getAttribute: (name: string) => attrs[name] ?? null,
    };

    const pending = ui.verifyLocalRuntime(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Verifying...");
    expect(resultEl.style.display).toBe("block");
    expect(resultEl.innerHTML).toContain("five behavioral checks");
    expect(apiPost).toHaveBeenCalledWith("/api/local-runtimes/certify", {
      runtimeId: "runtime-b", model: "shared-model",
    });

    release({
      ok: true,
      status: "verified",
      passedCount: 5,
      scenarioCount: 5,
      scenarios: [{ id: "baseline_marker", passed: true, latencyMs: 4, failure: null }],
    });
    await pending;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Verify again");
    expect(resultEl.innerHTML).toContain("Verified");
    expect(resultEl.innerHTML).toContain("Basic response");
    expect(badge.innerHTML).toContain("Verified");
  });

  it("reuses one pending certification after a rerender replaces the button", async () => {
    let release!: (value: unknown) => void;
    const apiPost = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { ui } = loadUi({ apiPost });
    const makeButton = () => {
      const result = { style: { display: "none" }, innerHTML: "" };
      const badge = { className: "status-badge", innerHTML: "" };
      const row = { querySelector: (selector: string) => selector.includes("result") ? result : badge };
      return {
        result,
        button: {
          disabled: false, textContent: "Verify", closest: () => row,
          getAttribute: (name: string) => name === "data-lr-runtime"
            ? encodeURIComponent("runtime:shared")
            : name === "data-lr-model" ? encodeURIComponent("model:shared") : null,
        },
      };
    };
    const first = makeButton();
    const firstPending = ui.verifyLocalRuntime(first.button);
    await Promise.resolve();
    await ui.loadLocalRuntimesEditor();
    const replacement = makeButton();
    const replacementPending = ui.verifyLocalRuntime(replacement.button);
    await Promise.resolve();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(replacement.button.disabled).toBe(true);
    expect(replacement.result.innerHTML).toContain("five behavioral checks");

    release({ ok: false, status: "failed", passedCount: 0, scenarioCount: 5, scenarios: [] });
    await Promise.all([firstPending, replacementPending]);
    expect(replacement.button.disabled).toBe(false);
    expect(replacement.result.innerHTML).toContain("Failed");
  });

  it("preserves manual remove rows alongside discovered verification rows", async () => {
    const { ui, list } = loadUi({
      apiJson: async () => ({
        manual: [{ kind: "ollama", baseUrl: "http://127.0.0.1:11434", label: "Desk" }],
        runtimes: [],
      }),
    });
    await ui.loadLocalRuntimesEditor();
    expect(String(list.innerHTML)).toContain("MANUAL ENDPOINTS");
    expect(String(list.innerHTML)).toContain("Desk");
    expect(String(list.innerHTML)).toContain("data-lr-remove");
  });
});
