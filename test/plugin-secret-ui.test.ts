import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const html = readFileSync(join(process.cwd(), "public", "app.html"), "utf-8");
const script = readFileSync(join(process.cwd(), "public", "js", "settings-integrations.js"), "utf-8");
const plugin = {
  id: "secret-plugin",
  registryId: "secret-plugin",
  name: "Secret Plugin",
  version: "1.2.3",
  publisher: "example.publisher",
  enabled: true,
  status: "needs_secrets",
  declaredTools: ["secret_action"],
  activeTools: [],
  requiredSecrets: [{ name: "FIRST_TOKEN" }, { name: "SECOND_TOKEN" }],
  missingSecrets: ["FIRST_TOKEN", "SECOND_TOKEN"],
  actions: { enable: false, disable: false, retry: false, configureSecrets: true },
};

async function setup(results: unknown[], projected = plugin) {
  const window = new Window({ url: "http://127.0.0.1" });
  window.document.body.innerHTML = '<div id="plugin-bundles-list"></div>';
  const calls: Array<{ path: string; body: unknown }> = [];
  const runtime = window as unknown as Record<string, unknown>;
  runtime.apiJson = vi.fn(async () => [projected]);
  runtime.apiPost = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body });
    return results.shift();
  });
  runtime.esc = (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;").replace(/\"/g, "&quot;");
  runtime.alert = vi.fn();
  window.eval(script);
  await window.eval("loadPluginBundles()") as Promise<void>;
  window.eval("openPluginSecrets('secret-plugin')");
  const inputs = [...window.document.querySelectorAll<HTMLInputElement>("[data-plugin-secret]")];
  inputs[0].value = "first-value";
  inputs[1].value = "second-value";
  return { window, calls, inputs };
}

describe("plugin secret settings UI", () => {
  it("renders repairable prerequisites in Tools & Integrations without paths or logging", () => {
    expect(html).toContain('id="plugin-bundles-list"');
    expect(script).toContain("status === 'needs_secrets'");
    expect(script).toContain("actions.configureSecrets");
    expect(script).toContain('type="password"');
    expect(script).not.toContain("plugin.path");
    expect(script).not.toContain("console.log");
  });

  it("replaces an existing setup modal instead of duplicating its ID", async () => {
    const { window } = await setup([]);

    window.eval("openPluginSecrets('secret-plugin')");

    expect(window.document.querySelectorAll("#plugin-secret-modal")).toHaveLength(1);
  });

  it("renders canonical identity/tool metadata and disables by registry identity", async () => {
    const enabled = { ...plugin, actions: { ...plugin.actions, disable: true } };
    const { window, calls } = await setup([{ ok: true }], enabled);
    const list = window.document.getElementById("plugin-bundles-list")!;

    expect(list.textContent).toContain("v1.2.3");
    expect(list.textContent).toContain("example.publisher");
    expect(list.textContent).toContain("Needs FIRST_TOKEN, SECOND_TOKEN");
    expect(list.querySelector("[data-plugin-disable]")).not.toBeNull();
    await window.eval("disablePluginBundle('secret-plugin')") as Promise<void>;

    expect(calls).toContainEqual({ path: "/api/plugins/unload", body: { id: "secret-plugin" } });
  });

  it("does not advertise disable or retry for a first-install secret candidate", async () => {
    const { window } = await setup([]);
    const list = window.document.getElementById("plugin-bundles-list")!;

    expect(list.querySelector("[data-plugin-configure-secrets]")).not.toBeNull();
    expect(list.querySelector("[data-plugin-disable]")).toBeNull();
    expect(list.querySelector("[data-plugin-retry]")).toBeNull();
  });

  it("saves disabled-plugin secrets without retrying or silently enabling it", async () => {
    const disabled = { ...plugin, enabled: false };
    const { window, calls } = await setup([{ ok: true }, { ok: true }], disabled);

    await window.eval("savePluginSecrets('secret-plugin')") as Promise<void>;

    expect(calls.map(call => call.path)).toEqual(["/api/secrets", "/api/secrets"]);
    expect(window.document.getElementById("plugin-secret-modal")).toBeNull();
  });

  it("renders the active-to-declared count from the canonical API projection", async () => {
    const window = new Window({ url: "http://127.0.0.1" });
    window.document.body.innerHTML = '<div id="plugin-bundles-list"></div>';
    const runtime = window as unknown as Record<string, unknown>;
    runtime.apiJson = vi.fn(async () => [{
      ...plugin,
      status: "loaded",
      missingSecrets: [],
      declaredTools: ["secret_action", "second_action"],
      activeTools: [{ name: "secret_action" }],
    }]);
    runtime.apiPost = vi.fn();
    runtime.esc = (value: unknown) => String(value ?? "");
    runtime.alert = vi.fn();
    window.eval(script);

    await window.eval("loadPluginBundles()") as Promise<void>;

    expect(window.document.getElementById("plugin-bundles-list")?.textContent).toContain("1/2 tools active");
  });

  it("stops on a first-secret 4xx, preserves values, and never retries", async () => {
    const { window, calls, inputs } = await setup([{ error: "<img src=x onerror=alert(1)>" }]);

    await window.eval("savePluginSecrets('secret-plugin')") as Promise<void>;

    expect(calls.map(call => call.path)).toEqual(["/api/secrets"]);
    expect(window.document.getElementById("plugin-secret-modal")).not.toBeNull();
    expect(inputs.map(input => input.value)).toEqual(["first-value", "second-value"]);
    expect(window.document.body.innerHTML).not.toContain("onerror=alert");
    expect(window.document.querySelector<HTMLElement>("[data-plugin-secret-error]")?.textContent).toContain("try again");
  });

  it("stops on a second-secret 4xx and never calls plugin retry", async () => {
    const { window, calls, inputs } = await setup([{ ok: true }, { error: "write failed" }]);

    await window.eval("savePluginSecrets('secret-plugin')") as Promise<void>;

    expect(calls.map(call => call.path)).toEqual(["/api/secrets", "/api/secrets"]);
    expect(window.document.getElementById("plugin-secret-modal")).not.toBeNull();
    expect(inputs.map(input => input.value)).toEqual(["first-value", "second-value"]);
  });

  it("keeps the modal and values when retry returns 4xx", async () => {
    const { window, calls, inputs } = await setup([{ ok: true }, { ok: true }, { error: "retry failed" }]);

    await window.eval("savePluginSecrets('secret-plugin')") as Promise<void>;

    expect(calls.map(call => call.path)).toEqual(["/api/secrets", "/api/secrets", "/api/plugins/retry"]);
    expect(window.document.getElementById("plugin-secret-modal")).not.toBeNull();
    expect(inputs.map(input => input.value)).toEqual(["first-value", "second-value"]);
  });

  it("disables Save while a request is pending and restores it after failure", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    const { window } = await setup([pending]);
    const save = window.document.querySelector<HTMLButtonElement>("[data-plugin-save]")!;

    const saving = window.eval("savePluginSecrets('secret-plugin')") as Promise<void>;
    expect(save.disabled).toBe(true);
    resolve({ error: "failed" });
    await saving;

    expect(save.disabled).toBe(false);
  });
});
