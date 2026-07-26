import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const script = readFileSync(join(process.cwd(), "public", "js", "settings-integrations.js"), "utf-8");

const MULTI = {
  id: "email",
  name: "Email",
  icon: "📧",
  description: "Send and read mail",
  authInstructions: "1. Get an app password",
  docsUrl: "",
  secretName: "SMTP_PASS",
  credentials: [
    { name: "SMTP_PASS", description: "App password for the outgoing server" },
    { name: "IMAP_PASS" },
    { name: "SMTP_HOST", secret: false },
  ],
};
// A config saved before the credential list existed: no `credentials` array at
// all, only the single derived `secretName`.
const LEGACY = {
  id: "legacy",
  name: "Legacy",
  icon: "🗄",
  description: "Saved before credential lists",
  authInstructions: "1. Paste the key",
  docsUrl: "",
  secretName: "LEGACY_API_KEY",
};
// What `POST /api/integrations {id,name,baseUrl}` yields: no credential list,
// so the registry derives an empty `secretName`.
const NO_CREDENTIALS = {
  id: "bare",
  name: "Bare",
  icon: "🔌",
  description: "Nothing to store",
  authInstructions: "Nothing needed",
  docsUrl: "",
  secretName: "",
  credentials: [],
};
const SINGLE = {
  id: "github",
  name: "GitHub",
  icon: "🐙",
  description: "Repos and issues",
  authInstructions: "1. Create a token",
  docsUrl: "",
  secretName: "GITHUB_TOKEN",
  credentials: [{ name: "GITHUB_TOKEN" }],
};

async function setup(config: unknown) {
  const window = new Window({ url: "http://127.0.0.1" });
  window.document.body.innerHTML = '<div id="integrations-list"></div>';
  const calls: Array<{ path: string; body: unknown }> = [];
  const runtime = window as unknown as Record<string, unknown>;
  runtime.apiJson = vi.fn(async () => config);
  runtime.apiPost = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { ok: true };
  });
  runtime.esc = (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;").replace(/\"/g, "&quot;");
  const alerts: string[] = [];
  runtime.alert = vi.fn((message: string) => { alerts.push(message); });
  window.eval(script);
  await window.eval(`showInstallModal('${(config as { id: string }).id}')`) as Promise<void>;
  const inputs = [...window.document.querySelectorAll<HTMLInputElement>("#install-modal [data-install-secret]")];
  return { window, calls, inputs, alerts };
}

describe("integration install modal", () => {
  it("renders one labelled field per declared credential with its description", async () => {
    const { window, inputs } = await setup(MULTI);
    const modal = window.document.getElementById("install-modal")!;

    expect(inputs.map(input => input.dataset.installSecret)).toEqual(["SMTP_PASS", "IMAP_PASS", "SMTP_HOST"]);
    expect(modal.textContent).toContain("(SMTP_PASS)");
    expect(modal.textContent).toContain("(IMAP_PASS)");
    expect(modal.textContent).toContain("App password for the outgoing server");
  });

  it("submits every collected value keyed by its declared credential name", async () => {
    const { window, calls, inputs } = await setup(MULTI);
    inputs[0].value = "smtp-secret";
    inputs[1].value = "imap-secret";
    inputs[2].value = "smtp.example.com";

    await window.eval("doInstallIntegration('email')") as Promise<void>;

    expect(calls).toEqual([{
      path: "/api/integrations/install",
      body: { id: "email", secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: "imap-secret", SMTP_HOST: "smtp.example.com" } },
    }]);
    expect(window.document.getElementById("install-modal")).toBeNull();
  });

  it("masks secret fields and leaves a non-secret config field readable", async () => {
    const { inputs } = await setup(MULTI);

    expect(inputs.map(input => input.type)).toEqual(["password", "password", "text"]);
  });

  it("refuses to submit while a declared field is empty", async () => {
    const { window, calls, inputs, alerts } = await setup(MULTI);
    inputs[0].value = "smtp-secret";

    await window.eval("doInstallIntegration('email')") as Promise<void>;

    expect(calls).toEqual([]);
    expect(alerts[0]).toContain("IMAP_PASS");
    expect(window.document.getElementById("install-modal")).not.toBeNull();
  });

  it("is unchanged for a single-credential integration", async () => {
    const { window, calls, inputs } = await setup(SINGLE);
    const modal = window.document.getElementById("install-modal")!;
    expect(inputs).toHaveLength(1);
    expect(modal.textContent).toContain("API Key / Token (GITHUB_TOKEN)");
    inputs[0].value = "ghp-token";

    await window.eval("doInstallIntegration('github')") as Promise<void>;

    expect(calls).toEqual([{
      path: "/api/integrations/install",
      body: { id: "github", secretValues: { GITHUB_TOKEN: "ghp-token" } },
    }]);
  });

  it("falls back to the derived secretName for a config that declares no credentials", async () => {
    const { window, calls, inputs } = await setup(LEGACY);
    const modal = window.document.getElementById("install-modal")!;

    expect(inputs.map(input => input.dataset.installSecret)).toEqual(["LEGACY_API_KEY"]);
    expect(modal.textContent).toContain("API Key / Token (LEGACY_API_KEY)");
    inputs[0].value = "legacy-key";

    await window.eval("doInstallIntegration('legacy')") as Promise<void>;

    expect(calls).toEqual([{
      path: "/api/integrations/install",
      body: { id: "legacy", secretValues: { LEGACY_API_KEY: "legacy-key" } },
    }]);
  });

  it("renders no field, and still connects, when the config declares no credentials", async () => {
    const { window, calls, inputs } = await setup(NO_CREDENTIALS);

    // A field named "" used to be rendered here from the `secretName` fallback,
    // and the install route rejects a credential it does not declare — so this
    // integration could never be connected from the UI at all.
    expect(inputs).toEqual([]);

    await window.eval("doInstallIntegration('bare')") as Promise<void>;

    expect(calls).toEqual([{ path: "/api/integrations/install", body: { id: "bare", secretValues: {} } }]);
    expect(window.document.getElementById("install-modal")).toBeNull();
  });

  it("trims a pasted value and refuses one that is only whitespace", async () => {
    const { window, calls, inputs, alerts } = await setup(SINGLE);
    inputs[0].value = "   ";

    await window.eval("doInstallIntegration('github')") as Promise<void>;
    expect(calls).toEqual([]);
    expect(alerts[0]).toContain("API key or token");

    inputs[0].value = "  ghp-token\n";
    await window.eval("doInstallIntegration('github')") as Promise<void>;

    expect(calls).toEqual([{
      path: "/api/integrations/install",
      body: { id: "github", secretValues: { GITHUB_TOKEN: "ghp-token" } },
    }]);
  });

  it("prompts with the paste hint for a single credential and the name for each of several", async () => {
    const single = await setup(SINGLE);
    const multi = await setup(MULTI);

    expect(single.inputs[0].placeholder).toBe("Paste your key or token here");
    expect(multi.inputs.map(input => input.placeholder)).toEqual(["Enter SMTP_PASS", "Enter IMAP_PASS", "Enter SMTP_HOST"]);
  });
});
