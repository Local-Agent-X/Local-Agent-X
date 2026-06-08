import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENV_PREFIXES,
  CREDENTIAL_KEY_PATTERNS,
  redact,
} from "../src/security/credential-patterns.js";
import { redactCredentials } from "../src/security/credentials.js";

const TAIL = "abcdef1234567890ABCDEFGH";

describe("credential-patterns — env-var name scrubbing", () => {
  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_REALTIME_KEY",
    "XAI_API_KEY",
    "CEREBRAS_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "SLACK_BOT_TOKEN",
    "DISCORD_TOKEN",
    "BRAVE_API_KEY",
    "NOTION_TOKEN",
    "VERCEL_TOKEN",
    "STRIPE_SECRET_KEY",
    "SUPABASE_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "HF_TOKEN",
    "HUGGINGFACE_API_KEY",
    "SMTP_PASSWORD",
    "IMAP_PASS",
    "DEEPSEEK_API_KEY",
    "VOICE_TOOLS_OPENAI_KEY",
    "SOMETHING_KEY",
    "SOMETHING_TOKEN",
    "SOMETHING_SECRET",
    "SOMETHING_PASSWORD",
  ])("flags %s as credential-bearing", (name) => {
    expect(CREDENTIAL_ENV_PREFIXES.test(name)).toBe(true);
  });

  it.each(["PATH", "HOME", "USERPROFILE", "NODE_ENV", "LAX_PORT", "LAX_DATA_DIR"])(
    "leaves %s alone",
    (name) => {
      expect(CREDENTIAL_ENV_PREFIXES.test(name)).toBe(false);
    },
  );
});

describe("credential-patterns — inline value redaction", () => {
  // One example for every shape in CREDENTIAL_KEY_PATTERNS. If a new pattern
  // is added without a fixture line here, this fixture stops covering the union.
  const fixtures: Array<[string, string]> = [
    ["Anthropic key", `sk-ant-${TAIL}${TAIL}`],
    ["OpenAI scoped key", `sk-proj-abcdefghij1234567890ABCD`],
    ["OpenAI key", `sk-${TAIL}${TAIL}`],
    ["Google API key", `AIza${"a".repeat(35)}`],
    ["GitHub PAT", `ghp_abcdefghij1234567890ABCDEFGHIJ123456`],
    ["GitHub fine-grained PAT", `github_pat_${TAIL}${TAIL}`],
    ["GitHub OAuth", `gho_abcdefghij1234567890ABCDEFGHIJ123456`],
    ["GitHub App install", `ghs_abcdefghij1234567890ABCDEFGHIJ123456`],
    ["Slack bot", `xoxb-${TAIL}-${TAIL}`],
    ["Telegram bot token", `123456789:${"A".repeat(35)}`],
    ["Discord token", `M${"A".repeat(23)}.Gabcd1.${"a".repeat(27)}`],
    ["GitLab PAT", `glpat-${TAIL}`],
    ["AWS access key", `AKIAABCDEFGHIJKLMNOP`],
    ["AWS secret key", `aws_secret_access_key = ${"A".repeat(40)}`],
    ["GCP service account", `"type": "service_account"`],
    ["Linear API", `lin_api_${TAIL}`],
    ["Stripe live", `sk_live_${TAIL}`],
    ["Stripe test", `sk_test_${TAIL}`],
    ["WooCommerce consumer key", `ck_${"a".repeat(40)}`],
    ["WooCommerce consumer secret", `cs_${"0".repeat(40)}`],
    ["Square", `sq0abc-${TAIL}`],
    ["xAI", `xai-${TAIL}`],
    ["Vercel", `vercel_${TAIL}`],
    ["npm", `npm_abcdefghij1234567890ABCDEFGHIJ123456`],
    ["Supabase", `sbp_${TAIL}`],
    ["SendGrid", `SG.${TAIL}.${TAIL}`],
    ["JWT", `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`],
    ["Bearer header", `Authorization: Bearer ${TAIL}${TAIL}`],
    ["api_key=value", `api_key="${TAIL}abc"`],
    ["client_secret base64", `client_secret: ${"A".repeat(40)}=`],
    ["Certificate", `-----BEGIN CERTIFICATE-----`],
    ["Database URL (also covers password-in-URL)", `postgres://user:pass@db.example.com:5432/mydb`],
    [
      "PEM private key",
      `-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBARileyBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n-----END RSA PRIVATE KEY-----`,
    ],
  ];

  it.each(fixtures)("%s — leaks no plaintext suffix after redact()", (_label, secret) => {
    const before = `prefix ${secret} suffix`;
    const after = redact(before);
    expect(after).not.toBe(before);
    // The original secret's tail must not appear verbatim in the output.
    const tail = secret.slice(-12);
    expect(after).not.toContain(tail);
  });

  it("redactCredentials and redact() produce identical output", () => {
    const fixtureText = fixtures.map(([, s]) => s).join("\n");
    expect(redactCredentials(fixtureText)).toBe(redact(fixtureText));
  });

  it("every pattern in CREDENTIAL_KEY_PATTERNS matches at least one fixture", () => {
    const fixtureText = fixtures.map(([, s]) => s).join("\n");
    for (const pattern of CREDENTIAL_KEY_PATTERNS) {
      const p = new RegExp(pattern.source, pattern.flags);
      expect(p.test(fixtureText), `no fixture matches ${pattern}`).toBe(true);
    }
  });
});

describe("credential-patterns — cross-scrubber coverage", () => {
  it("a fake Anthropic key is caught by env-name match AND inline redaction", () => {
    const secret = `sk-ant-${TAIL}${TAIL}`;
    // Env-name path: a variable named ANTHROPIC_API_KEY would be filtered.
    expect(CREDENTIAL_ENV_PREFIXES.test("ANTHROPIC_API_KEY")).toBe(true);
    // Inline path: the same value embedded in a string gets masked.
    const masked = redact(`leaked=${secret}`);
    expect(masked).not.toContain(secret);
    expect(masked).toContain("[REDACTED]");
  });
});
