// A file the model writes: one of the user's own stored secrets, byte for
// byte, is refused. Anything that merely looks like a key is saved without a
// question: saving sends nothing off the machine, and the question is asked
// where the content would leave (the egress guard, the publish gate).
import { afterEach, describe, expect, it } from "vitest";
import { secretInContentRejection, writeTool } from "./read-write-tools.js";
import { registerRedactedSecretValue, unregisterRedactedSecretValue, vaultSecretSource } from "../security/secrets/index.js";

const VAULT = vaultSecretSource("TV_TEST_KEY");

const GUESSES = [
  `OPENAI_API_KEY = "sk-proj-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}"`,
  `password = "hunter2hunter2hunter2hunter2"`,
  `token = ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}`,
  `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`,
  `-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
  `{"url": "https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/"}`,
];

describe("a secret in a written file", () => {
  const STORED = "vT9qL2xW7mK4pR8nZ3cY6bH1";
  afterEach(() => { unregisterRedactedSecretValue(STORED); unregisterRedactedSecretValue(STORED, VAULT); });

  it.each(GUESSES)("saves a key shape without refusing it or asking: %s", (content) => {
    expect(secretInContentRejection("/app/config.py", content)).toBeNull();
  });

  it("the write tool raises no card of its own", () => {
    expect(writeTool.confirmWithUser).toBeUndefined();
  });

  it("refuses a value from the user's vault, byte for byte", () => {
    registerRedactedSecretValue(STORED, VAULT);
    expect(secretInContentRejection("/app/a.js", `const key = "${STORED}";`)).toMatch(/^BLOCKED: The content contains one of the user's stored secrets/);
  });

  it("does not refuse a value the output masker only saw: it was registered for its shape", () => {
    registerRedactedSecretValue(STORED);
    expect(secretInContentRejection("/app/a.js", `const key = "${STORED}";`)).toBeNull();
  });

  it("does not scan stylesheets and SVG, even for a stored secret", () => {
    registerRedactedSecretValue(STORED, VAULT);
    expect(secretInContentRejection("/app/a.svg", `<svg data-k="${STORED}"/>`)).toBeNull();
  });
});
