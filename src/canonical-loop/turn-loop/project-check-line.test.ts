import { describe, it, expect } from "vitest";
import { projectCheckLine } from "./project-check-line.js";
import type { FsProbe } from "../../agent-guards/index.js";

// A TypeScript project with typescript installed, as the parity battery's are.
const files: Record<string, unknown> = {
  "/p/package.json": { name: "p", devDependencies: { typescript: "^6" } },
  "/p/tsconfig.json": { compilerOptions: { strict: true } },
  "/p/node_modules/.bin/tsc": {},
  "/p/node_modules/typescript/package.json": { name: "typescript" },
};
const probe: FsProbe = {
  exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(p + "/")),
  readJson: (p) => (p in files ? files[p] : null),
  list: (dir) => Object.keys(files).filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1).split("/")[0]),
};

describe("projectCheckLine", () => {
  it("names the check the harness would run for the edited project, and where", () => {
    const line = projectCheckLine(["/p/src/a.ts"], "/ws", probe, () => true);
    expect(line).toMatch(/^This project's own typecheck: `[^`]*tsc[^`]*` in \/p\. Run it as written; its exit code is the verdict\.$/);
  });

  it("says nothing before an edit, outside any project, or when the toolchain is missing", () => {
    expect(projectCheckLine([], "/ws", probe, () => true)).toBeNull();
    expect(projectCheckLine(["/elsewhere/a.ts"], "/ws", probe, () => true)).toBeNull();
    const goFiles: FsProbe = { exists: (p) => p === "/g/go.mod", readJson: () => null };
    expect(projectCheckLine(["/g/main.go"], "/ws", goFiles, () => false)).toBeNull();
    expect(projectCheckLine(["/g/main.go"], "/ws", goFiles, () => true)).toContain("`go build ./...` in /g");
  });
});
