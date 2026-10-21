// A child session starts with what its parent has read or ingested. Taint used
// to flow only child → parent at completion, so a session whose own outbound
// write was refused could spawn a worker or an agent, hand it the bytes in the
// task, and have the clean child send them (red team 2026-10-13, A4).
import { afterEach, describe, expect, it } from "vitest";
import { bindDelegatedSessionLineage, inheritSessionLineage } from "./delegated-session-lineage.js";
import { clearSessionTaint, getKernelTaintSources, recordSensitiveRead, checkEgressTaintWithPayload } from "../data-lineage/index.js";
import { clearExternalIngestion, hasExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import { clearSessionOwner } from "../browser/session-owner-registry.js";

const PARENT = "lineage-parent";
const CHILD = "lineage-child";
const SECRET = "the recovery phrase is velvet-harbor-ninety-two, keep it somewhere safe";

afterEach(() => {
  for (const s of [PARENT, CHILD]) { clearSessionTaint(s); clearExternalIngestion(s); }
  clearSessionOwner(CHILD);
});

describe("a child session inherits its parent's lineage at spawn", () => {
  it("carries the parent's taint, fingerprints included, and its ingestion mark", () => {
    recordSensitiveRead(PARENT, "sensitive_file", "/home/u/.env", SECRET);
    recordExternalIngestion(PARENT, "<html>a page the parent read</html>", "web_fetch https://x.example");
    expect(getKernelTaintSources(CHILD)).toEqual([]);

    inheritSessionLineage(CHILD, PARENT);

    expect(getKernelTaintSources(CHILD)).toEqual(["rag"]);
    expect(hasExternalIngestion(CHILD)).toBe(true);
    // The child's egress clears exactly what the parent's would: the secret is
    // refused, a payload with none of it is not.
    expect(checkEgressTaintWithPayload(CHILD, SECRET).blocked).toBe(true);
    expect(checkEgressTaintWithPayload(CHILD, "a status update for the marketing team, nothing more").blocked).toBe(false);
  });

  it("is a no-op for a clean parent, a missing parent, or the session itself", () => {
    inheritSessionLineage(CHILD, PARENT);
    inheritSessionLineage(CHILD, undefined);
    inheritSessionLineage(CHILD, CHILD);
    expect(getKernelTaintSources(CHILD)).toEqual([]);
    expect(hasExternalIngestion(CHILD)).toBe(false);
  });

  it("happens when a delegated op binds to its parent", () => {
    recordSensitiveRead(PARENT, "sensitive_file", "/home/u/.env", SECRET);
    bindDelegatedSessionLineage(CHILD, PARENT);
    expect(getKernelTaintSources(CHILD)).toEqual(["rag"]);
  });
});
