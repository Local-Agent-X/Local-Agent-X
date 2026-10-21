// A vault secret handed to a command reaches the process environment and
// nowhere the model can read. Live 2026-09-26: a working Supabase token could
// not deploy three functions because the shell had no route to the vault.
// A media provider's API key is the exception while paid API keys for images
// and video are off (Settings → Media): the shell's proxy cannot see which
// route a TLS call takes, so the key is kept from the command instead.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const XAI_KEY = "xai-" + "k".repeat(40);
const VAULT: Record<string, string> = {
  SUPABASE_TOKEN: "sbp_0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  OPENAI_API_KEY: "sk-" + "o".repeat(40),
  XAI_API_KEY: XAI_KEY,
  // The same xAI key the user also saved under a name of their own.
  GROK_IMAGINE_KEY: XAI_KEY,
};
vi.mock("../secrets.js", () => ({ getSecretsStoreSingleton: () => ({ get: (name: string) => VAULT[name] }) }));
// The user's copy of a withheld output: what the inbox producer was handed.
const inboxItems = vi.hoisted(() => [] as Array<{ key: string; program: string; secrets: string[]; reason: string; exit: string; output: string }>);
vi.mock("../inbox/producers.js", () => ({ inboxWithheldOutput: (o: (typeof inboxItems)[number]) => { inboxItems.push(o); } }));
let settingsBag: Record<string, unknown> = {};
vi.mock("../settings.js", async (orig) => ({ ...(await orig<typeof import("../settings.js")>()), loadSettings: () => settingsBag }));

const { secretEnvOf, secretEnvProgram, resolveSecretEnv, paidMediaSecretEnvRefusal, secretManipulation } = await import("./shell-secret-env.js");
const { bashTool } = await import("./shell-tool.js");

beforeEach(() => { settingsBag = {}; inboxItems.length = 0; });

// The scrub recognises the whole value. A command that works on the value in
// its own text can print it in pieces the scrub cannot recognise, so that
// command's output is the user's, not the model's. A command that hands the
// value to a program is the sanctioned use and is not judged.
describe("a command that works on a secret's value, judged from its text", () => {
  const ENV = { TOKEN: "SUPABASE_TOKEN" };

  it.each([
    ["npx supabase functions deploy food-search", null],
    ["gh pr list --repo acme/app", null],
    ['curl -H "Authorization: Bearer $TOKEN" https://api.example/v1/me', null],
    ["GH_TOKEN=$TOKEN gh auth status", null],
    ["python deploy.py --project abc", null],
    ['python -c "print(1 + 1)"', null],
    ['echo "deploying" && npx vercel deploy --token "$TOKEN"', null],
    ['test -n "$TOKEN" && echo set', null],
  ])("hands the value to a program: %s", (command, verdict) => {
    expect(secretManipulation(command, ENV)).toBe(verdict);
  });

  it.each([
    ["echo ${TOKEN:0:4}", "slices or rewrites $TOKEN"],
    ["echo ${TOKEN//a/b}", "slices or rewrites $TOKEN"],
    ["echo %TOKEN:~0,4%", "slices or rewrites $TOKEN"],
    ["$env:TOKEN.Substring(0, 4)", "slices or rewrites $TOKEN"],
    ["echo $TOKEN | rev", "prints $TOKEN"],
    ['printf "%s" "$TOKEN" | base64', "prints $TOKEN"],
    ["Write-Host $env:TOKEN", "prints $TOKEN"],
    ['base64 <<< "$TOKEN"', "prints $TOKEN"],
    ["X=$TOKEN; echo ${X:2}", "slices or rewrites $X"],
    ['sh -c "echo $TOKEN | fold -w 4"', "prints $TOKEN"],
    ["env", "dumps the environment"],
    ["printenv TOKEN", "dumps the environment"],
    ["Get-ChildItem env:", "dumps the environment"],
    ['python -c "import os; print(os.environ[\'TOKEN\'][::-1])"', "reads $TOKEN in inline code"],
    ['node -e "console.log(process.env.TOKEN.split(\'\'))"', "reads $TOKEN in inline code"],
    ['python3 -c "import os; print(dict(os.environ))"', "reads the environment in inline code"],
  ])("works on the value: %s", (command, reason) => {
    expect(secretManipulation(command, ENV)).toBe(`this command ${reason}`);
  });

  it("resolveSecretEnv carries the verdict for the command the values go to", () => {
    const handsOff = resolveSecretEnv(ENV, "gh pr list");
    const worksOn = resolveSecretEnv(ENV, "echo $TOKEN | rev");
    if ("refusal" in handsOff || "refusal" in worksOn) throw new Error("unexpected refusal");
    expect(handsOff.withheld).toBeNull();
    expect(worksOn.withheld).toBe("this command prints $TOKEN");
    expect(resolveSecretEnv(ENV)).toMatchObject({ withheld: null });
  });
});

describe("secret_env arguments", () => {
  it("reads { ENV_VAR: SECRET_NAME } and rejects anything else by name", () => {
    expect(secretEnvOf({ command: "x" })).toBeNull();
    expect(secretEnvOf({ secret_env: {} })).toBeNull();
    expect(secretEnvOf({ secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" } })).toEqual({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    expect(() => secretEnvOf({ secret_env: ["SUPABASE_TOKEN"] })).toThrow(/object/);
    expect(() => secretEnvOf({ secret_env: { "BAD-NAME": "SUPABASE_TOKEN" } })).toThrow(/environment variable/);
    expect(() => secretEnvOf({ secret_env: { TOKEN: "sbp_raw_value_pasted_in" } })).toThrow(/stored secret/);
  });

  it("names the program the way the user would", () => {
    expect(secretEnvProgram("npx supabase functions deploy food-search --project-ref abc")).toBe("npx supabase");
    expect(secretEnvProgram("FOO=1 gh pr list")).toBe("gh");
    expect(secretEnvProgram("/usr/local/bin/vercel deploy")).toBe("vercel");
  });

  it("resolves from the vault, reports a missing secret by name, and scrubs the value", () => {
    const ok = resolveSecretEnv({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    if ("refusal" in ok) throw new Error(`unexpected refusal: ${ok.refusal}`);
    expect(ok.env).toEqual({ SUPABASE_ACCESS_TOKEN: VAULT.SUPABASE_TOKEN });
    expect(ok.scrub(`Authorization: Bearer ${VAULT.SUPABASE_TOKEN}`)).toBe("Authorization: Bearer [secret SUPABASE_TOKEN]");
    expect(resolveSecretEnv({ X: "NOT_STORED" })).toEqual({ refusal: expect.stringMatching(/not in the vault: NOT_STORED.*request_secrets/) });
  });

  it("an open-ended read also masks a value the text stops partway through", () => {
    const ok = resolveSecretEnv({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    if ("refusal" in ok) throw new Error(`unexpected refusal: ${ok.refusal}`);
    const value = VAULT.SUPABASE_TOKEN;
    expect(ok.scrubOpenEnded(`token=${value.slice(0, 20)}`)).toBe("token=[secret SUPABASE_TOKEN]");
    expect(ok.scrubOpenEnded(`a ${value} b ${value.slice(0, 9)}`)).toBe("a [secret SUPABASE_TOKEN] b [secret SUPABASE_TOKEN]");
    // A few leading characters say nothing about the value and stay as printed.
    expect(ok.scrubOpenEnded("version sbp")).toBe("version sbp");
    expect(ok.scrubOpenEnded("all done\n")).toBe("all done\n");
  });
});

describe("a media provider's API key while paid API keys for images and video are off", () => {
  const IMAGE_OFF = "Paid API image generation is off — turn on 'Allow paid API keys for images and video' in Settings → Media.";
  const BOTH_OFF = "Paid API image or video generation is off — turn on 'Allow paid API keys for images and video' in Settings → Media.";

  it("is refused by name, with the same message the image tools and http_request give", () => {
    const openai = resolveSecretEnv({ OPENAI_API_KEY: "OPENAI_API_KEY" });
    expect(openai).toEqual({ refusal: expect.stringContaining(IMAGE_OFF) });
    expect((openai as { refusal: string }).refusal).toMatch(/^secret_env: OPENAI_API_KEY is a per-use-billed image API key/);
    const xai = resolveSecretEnv({ XAI_API_KEY: "XAI_API_KEY" });
    expect(xai).toEqual({ refusal: expect.stringContaining(BOTH_OFF) });
    expect(paidMediaSecretEnvRefusal({ KEY: "XAI_API_KEY" })).toContain("XAI_API_KEY is a per-use-billed image or video API key");
  });

  it("is refused under any name the same key was saved as, and the env var name does not matter", () => {
    expect(resolveSecretEnv({ GROK_KEY: "GROK_IMAGINE_KEY" })).toEqual({ refusal: expect.stringContaining(BOTH_OFF) });
    expect(resolveSecretEnv({ TOKEN: "OPENAI_API_KEY" })).toEqual({ refusal: expect.stringContaining(IMAGE_OFF) });
  });

  it("a secret that is not a media provider's key is handed over as before", () => {
    const ok = resolveSecretEnv({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    expect("refusal" in ok).toBe(false);
    expect(paidMediaSecretEnvRefusal({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" })).toBeNull();
  });

  it("the switch on hands the key over", () => {
    settingsBag = { allowPaidMediaApis: true };
    for (const name of ["OPENAI_API_KEY", "XAI_API_KEY", "GROK_IMAGINE_KEY"]) {
      const ok = resolveSecretEnv({ KEY: name });
      if ("refusal" in ok) throw new Error(`refused ${name}: ${ok.refusal}`);
      expect(ok.env).toEqual({ KEY: VAULT[name] });
    }
    expect(paidMediaSecretEnvRefusal({ KEY: "OPENAI_API_KEY" })).toBeNull();
  });

  it("a paid key is refused before any secret is read, even beside a missing one; a missing one alone is still reported", () => {
    expect(resolveSecretEnv({ A: "NOT_STORED", B: "OPENAI_API_KEY" })).toEqual({ refusal: expect.stringContaining(IMAGE_OFF) });
    expect(resolveSecretEnv({ A: "NOT_STORED", B: "SUPABASE_TOKEN" })).toEqual({ refusal: expect.stringMatching(/not in the vault: NOT_STORED/) });
  });
});

describe("bash with secret_env", () => {
  // About secret delivery, not confinement. Where the Windows cage is
  // installed, bash waits for the cage's startup proof and then runs under the
  // cage's own logon, which the test's stand-in profile leaves unable to
  // start the shell (no read grant is made for it).
  let prevSandbox: string | undefined;
  beforeAll(() => {
    prevSandbox = process.env.LAX_SANDBOX;
    process.env.LAX_SANDBOX = "host";
  });
  afterAll(() => {
    if (prevSandbox === undefined) delete process.env.LAX_SANDBOX;
    else process.env.LAX_SANDBOX = prevSandbox;
  });

  // A program that reads its own environment and happens to print the value:
  // the sanctioned use, with the whole value scrubbed from what the model reads.
  const scriptDir = mkdtempSync(join(tmpdir(), "lax-secret-env-"));
  const printScript = join(scriptDir, "print.sh").replace(/\\/g, "/");
  writeFileSync(printScript, 'echo "set, ${#SUPABASE_ACCESS_TOKEN} chars: $SUPABASE_ACCESS_TOKEN"\n');
  afterAll(() => rmSync(scriptDir, { recursive: true, force: true }));

  it("the command gets the value in its environment; the output never carries it", async () => {
    const result = await bashTool.execute({
      command: `sh "${printScript}"`,
      secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" },
    });
    const text = String(result.content);
    expect(text).toContain(`set, ${VAULT.SUPABASE_TOKEN.length} chars: [secret SUPABASE_TOKEN]`);
    expect(text).not.toContain(VAULT.SUPABASE_TOKEN);
    expect(inboxItems).toEqual([]);
  });

  it("a command that works on the value runs, but its output goes to the user's inbox, not the model", async () => {
    const piece = VAULT.SUPABASE_TOKEN.slice(0, 12);
    const result = await bashTool.execute({
      command: 'echo "$SUPABASE_ACCESS_TOKEN" | cut -c1-12',
      secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" },
      _toolCallId: "call-7",
    });
    const shown = JSON.stringify(result);
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/output withheld from the model: this command prints \$SUPABASE_ACCESS_TOKEN/);
    expect(String(result.content)).toContain("http_request with {{SUPABASE_TOKEN}}");
    expect(result.metadata).toMatchObject({ exit_code: 0, output_withheld: true });
    expect(result.metadata).not.toHaveProperty("stderr");
    expect(result.metadata).not.toHaveProperty("partial_output");
    expect(shown).not.toContain(piece);
    expect(shown).not.toContain(VAULT.SUPABASE_TOKEN);
    // The user has it, scrubbed as every reader's copy is: the piece is
    // theirs to see, the whole value is still masked.
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]).toMatchObject({ key: "withheld:call-7", program: "echo", secrets: ["SUPABASE_TOKEN"], reason: "this command prints $SUPABASE_ACCESS_TOKEN", exit: expect.stringMatching(/^exit 0 in \d+ms$/) });
    expect(inboxItems[0].output.trim()).toBe(piece);
  });

  it("a secret that is not stored stops the call and says how to get it", async () => {
    const result = await bashTool.execute({ command: "echo hi", secret_env: { T: "NOT_STORED" } });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/NOT_STORED.*request_secrets/);
  });

  it("a media provider's key stops the call while paid API keys are off; nothing runs", async () => {
    const result = await bashTool.execute({ command: "echo ran", secret_env: { OPENAI_API_KEY: "OPENAI_API_KEY" } });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Paid API image generation is off");
    expect(String(result.content)).not.toContain("ran");
  });
});
