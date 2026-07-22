import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reopenReservedProjection,
  writeProjectionReservation,
} from "./container-projection-reservation.js";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("container projection reservation", () => {
  it("reopens and cleans an owned projection interrupted before its manifest", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-projection-reservation-"));
    const projectionId = "12345678-1234-4123-8123-123456789abc";
    const opId = "op-reserved";
    const descriptorMac = "a".repeat(64);
    const projectionRoot = join(root, projectionId);
    mkdirSync(projectionRoot, { mode: 0o700 });
    writeProjectionReservation(projectionRoot, projectionId, opId, descriptorMac);

    const projection = reopenReservedProjection(projectionRoot, projectionId, opId, descriptorMac);
    expect(projection?.durableId).toBe(projectionId);
    await projection?.cleanup();
    expect(existsSync(projectionRoot)).toBe(false);
  });

  it("cleans the pre-bound empty-root crash boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-projection-reservation-"));
    const projectionId = "12345678-1234-4123-8123-123456789abc";
    const projectionRoot = join(root, projectionId);
    mkdirSync(projectionRoot, { mode: 0o700 });

    const projection = reopenReservedProjection(
      projectionRoot, projectionId, "op-reserved", "a".repeat(64),
    );
    await projection?.cleanup();
    expect(existsSync(projectionRoot)).toBe(false);
  });
});
