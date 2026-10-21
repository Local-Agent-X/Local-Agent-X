// A worker's projected credentials — the provider key, the audit seed, the
// bootstrap — are plaintext files under `<laxDir>/cr/<op>/secrets/` on the
// host and `/run/lax-secrets/` in the container. None was enrolled as an
// at-rest secret (the audit key was, but the gate required a `.lax` segment
// the container mount lacks), so a worker's own shell could read and ship
// them (red team round 2, S-H1). The whole directory is secret material now,
// under either root, in the file gate and the read-taint classifier alike.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { isAppAtRestSecretUnderLax } from "./lax-control-files.js";
import { matchesSensitivePath } from "./file-access.js";
import { isSensitivePath } from "../../data-lineage/paths.js";
import { CONTAINER_SECRETS_MOUNT, PROJECTION_ROOT_DIRNAME, PROJECTION_SECRETS_DIRNAME } from "../secrets/index.js";

const lax = getLaxDir();
const OP = "op_7f3a9c";
const projected = (file: string) => join(lax, PROJECTION_ROOT_DIRNAME, OP, PROJECTION_SECRETS_DIRNAME, file);

describe("a projected credential file", () => {
  it("is an at-rest secret under the data dir and at the container mount, whatever it is called", () => {
    for (const p of [
      projected("runtime-credential.json"),
      projected("audit-key"),
      projected("bootstrap.json"),
      projected("local-runtime.json"),
      `${CONTAINER_SECRETS_MOUNT}/runtime-credential.json`,
      `${CONTAINER_SECRETS_MOUNT}/audit-key`,
      "/home/u/.lax/cr/op_1/secrets/runtime-credential.json",
    ]) {
      expect(isAppAtRestSecretUnderLax(p), p).toBe(true);
      expect(matchesSensitivePath(p), p).toBe("app-at-rest-secret");
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("while the projection's other files, and a project's own cr/secrets layout, are not", () => {
    for (const p of [
      join(lax, PROJECTION_ROOT_DIRNAME, OP, "manifest.json"),
      join(lax, PROJECTION_ROOT_DIRNAME, OP, "state", "ops.json"),
      "/home/u/project/cr/x/secrets/config.json",
      "C:\\Users\\u\\code\\cr\\build\\secrets\\notes.md",
    ]) {
      expect(isAppAtRestSecretUnderLax(p), p).toBe(false);
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});
