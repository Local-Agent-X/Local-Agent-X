// A file the model writes is judged by the canonical scanner. A guess is put to
// the user as a card (the write tool's confirmWithUser); only one of the
// user's own stored secrets, byte for byte, is refused. Saving a file sends
// nothing off the machine, and a refusal with no yes left a TV remote's
// pairing module unwritable (2026-11-20).
import { afterEach, describe, expect, it } from "vitest";
import { secretInContentQuestion, secretInContentRejection, writeTool } from "./read-write-tools.js";
import { registerRedactedSecretValue, unregisterRedactedSecretValue, vaultSecretSource } from "../security/secrets/index.js";

const VAULT = vaultSecretSource("TV_TEST_KEY");

const PROTEIN_FILE = `# PDB 5WJ2 core, His-tag stripped, X->GYG
DONOR = "GSSHHHHHHSSGENLYFQGHMSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTFGYGLQCFARYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK"
CODONS = {"A": "GCT", "K": "AAA", "P": "CCG", "S": "AGC", "Y": "TAT"}
dna = "ATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGCCACAAGTTCAGCGTGTCCGGCGAGGGCGAGGGCGATGCCACCTACGGCAAG"
`;

const GUESSES = [
  `OPENAI_API_KEY = "sk-proj-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}"`,
  `password = "hunter2hunter2hunter2hunter2"`,
  `token = ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}`,
  `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`,
  `-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
];

describe("a secret in a written file", () => {
  const STORED = "vT9qL2xW7mK4pR8nZ3cY6bH1";
  afterEach(() => { unregisterRedactedSecretValue(STORED); unregisterRedactedSecretValue(STORED, VAULT); });

  it("lets data that merely looks dense through: protein and DNA sequences, hashes, base64 image bytes", () => {
    for (const [path, content] of [
      ["/app/assemble.py", PROTEIN_FILE],
      ["/app/sums.txt", "sha256 = 3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a"],
      ["/app/style.css", `.a{background:url(data:image/png;base64,${"QUJD".repeat(40)})}`],
    ]) {
      expect(secretInContentQuestion(path, content)).toBeNull();
      expect(secretInContentRejection(path, content)).toBeNull();
    }
  });

  it.each(GUESSES)("asks the user about a key shape, and does not refuse it: %s", (content) => {
    expect(secretInContentRejection("/app/config.py", content)).toBeNull();
    expect(secretInContentQuestion("/app/config.py", content)).toMatch(/^Saving config\.py would put .* on line 1 .*Approve if it isn't a secret/);
  });

  it("names the line the guess is on, masked", () => {
    const content = `const a = 1;\nconst b = 2;\n${GUESSES[2]}\n`;
    const question = secretInContentQuestion("/app/remote/vizio.js", content) ?? "";
    expect(question).toContain("on line 3");
    expect(question).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("refuses a value from the user's vault, byte for byte, without a card", () => {
    registerRedactedSecretValue(STORED, VAULT);
    const content = `const key = "${STORED}";`;
    expect(secretInContentRejection("/app/a.js", content)).toMatch(/^BLOCKED: The content contains one of the user's stored secrets/);
    expect(secretInContentQuestion("/app/a.js", content)).toBeNull();
  });

  it("asks about a value the output masker only saw: it was registered for its shape", () => {
    registerRedactedSecretValue(STORED);
    const content = `const key = "${STORED}";`;
    expect(secretInContentRejection("/app/a.js", content)).toBeNull();
    expect(secretInContentQuestion("/app/a.js", content)).toMatch(/^Saving a\.js/);
  });

  it("is the write tool's own confirmation", () => {
    expect(writeTool.confirmWithUser?.({ path: "/app/config.py", content: GUESSES[1] }, { userText: "" })).toMatch(/^Saving config\.py/);
    expect(writeTool.confirmWithUser?.({ path: "/app/ok.py", content: "x = 1" }, { userText: "" })).toBeNull();
  });

  it("does not scan stylesheets and SVG", () => {
    expect(secretInContentQuestion("/app/a.svg", `<svg data-k="ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}"/>`)).toBeNull();
  });
});
