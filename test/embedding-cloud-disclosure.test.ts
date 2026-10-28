// @vitest-environment happy-dom
//
// Picking OpenAI or Gemini as the embedding provider sends the text of chat
// history, facts and knowledge files to that company, and the settings page
// never said so. The dropdown now names the cloud options as cloud, and
// choosing one shows a warning; the on-machine options show none.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const embeddingJs = readFileSync(join(here, "../public/js/settings-embedding.js"), "utf8");
const appHtml = readFileSync(join(here, "../public/app.html"), "utf8");

type OnChange = (provider: string) => Promise<void>;

function load(): OnChange {
  return new Function(
    "apiJson", "esc",
    `${embeddingJs}\nreturn onEmbProviderChange;`,
  )(async () => ({ models: [{ name: "mxbai-embed-large:latest", embeddingOnly: true }] }), (s: unknown) => String(s));
}

beforeEach(() => {
  const providerField = appHtml.match(/<div class="field"><label class="field-label">Provider<\/label><select class="field-select" id="cfg-emb-provider"[\s\S]*?<div class="mem-card-divider">/);
  document.body.innerHTML = providerField ? providerField[0] + "</div>" : "";
});

const warning = () => document.getElementById("cfg-emb-cloud-warning") as HTMLElement;

describe("the embedding provider setting says when data leaves the computer", () => {
  it("labels the cloud providers as cloud in the dropdown", () => {
    const labels = [...document.querySelectorAll("#cfg-emb-provider option")].map((o) => o.textContent);
    expect(labels).toContain("OpenAI (cloud: sends your memory text to OpenAI)");
    expect(labels).toContain("Google Gemini (cloud: sends your memory text to Google)");
  });

  it("warns on a cloud provider, naming what is sent and that project documents are not", async () => {
    const onChange = load();
    await onChange("openai");
    expect(warning().hidden).toBe(false);
    expect(warning().textContent).toContain("sends OpenAI the text of your chat history, saved facts and knowledge files");
    expect(warning().textContent).toContain("Project documents are not sent");
    await onChange("gemini");
    expect(warning().textContent).toContain("sends Google");
  });

  it("shows no warning for the providers that run on this computer", async () => {
    const onChange = load();
    await onChange("openai");
    for (const provider of ["ollama", "local", "none"]) {
      await onChange(provider);
      expect(warning().hidden).toBe(true);
    }
  });
});
