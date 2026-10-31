// The write tool refuses a file that carries a credential, by the canonical
// scanner's judgement. Its own regex list refused a file of protein sequences
// (Terminal-Bench protein-assembly, 2026-10-29: any 22-letter run around "sk"
// or "key" read as a key) and let a real OpenAI key and a password through.
import { describe, expect, it } from "vitest";
import { secretInContentRejection } from "./read-write-tools.js";

const PROTEIN_FILE = `# PDB 5WJ2 core, His-tag stripped, X->GYG
DONOR = "GSSHHHHHHSSGENLYFQGHMSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTFGYGLQCFARYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK"
CODONS = {"A": "GCT", "K": "AAA", "P": "CCG", "S": "AGC", "Y": "TAT"}
dna = "ATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGCCACAAGTTCAGCGTGTCCGGCGAGGGCGAGGGCGATGCCACCTACGGCAAG"
`;

describe("secretInContentRejection", () => {
  it("lets data that merely looks dense through: protein and DNA sequences, hashes, base64 image bytes", () => {
    expect(secretInContentRejection("/app/assemble.py", PROTEIN_FILE)).toBeNull();
    expect(secretInContentRejection("/app/sums.txt", "sha256 = 3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a")).toBeNull();
    expect(secretInContentRejection("/app/style.css", `.a{background:url(data:image/png;base64,${"QUJD".repeat(40)})}`)).toBeNull();
  });

  it("refuses a credential, including the shapes the old list missed", () => {
    const refused = (content: string) => expect(secretInContentRejection("/app/config.py", content)).toMatch(/BLOCKED: Content appears to contain a secret/);
    refused(`OPENAI_API_KEY = "sk-proj-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}"`);
    refused(`password = "hunter2hunter2hunter2hunter2"`);
    refused(`token = ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}`);
    refused(`aws_access_key_id = AKIAIOSFODNN7EXAMPLE`);
    refused(`-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`);
  });

  it("does not scan stylesheets and SVG", () => {
    expect(secretInContentRejection("/app/a.svg", `<svg data-k="ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}"/>`)).toBeNull();
  });
});
