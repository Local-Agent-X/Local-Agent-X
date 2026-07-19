import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PluginManifest } from "./manifest.js";
import { verifyPublisherSignature, type TrustLevel } from "./publisher-trust.js";

export function assessTrustLevel(
  manifest: PluginManifest,
  entryFilePath: string,
  registeredHash: string | undefined,
): { trustLevel: TrustLevel; currentHash: string; warning?: string } {
  const currentHash = createHash("sha256").update(readFileSync(entryFilePath)).digest("hex");
  if (registeredHash && registeredHash !== currentHash) {
    throw new Error(
      `Plugin "${manifest.id}" entry point has been tampered with. ` +
      `Expected hash ${registeredHash.slice(0, 12)}..., got ${currentHash.slice(0, 12)}.... ` +
      "If this is intentional, remove and reinstall the plugin.",
    );
  }

  if (manifest.signature && manifest.publisher) {
    const verdict = verifyPublisherSignature(
      manifest.publisher,
      readFileSync(entryFilePath),
      manifest.signature,
      manifest.keyId,
    );
    if (verdict.status !== "unknown-publisher") {
      if (verdict.status === "valid") return { trustLevel: "signed", currentHash };
      throw new Error(
        `Plugin "${manifest.id}" has an invalid signature from publisher "${manifest.publisher}". ` +
        "The plugin may have been tampered with.",
      );
    }
    return {
      trustLevel: "unsigned",
      currentHash,
      warning: `Plugin "${manifest.id}" is signed by unknown publisher "${manifest.publisher}". ` +
        "Add them to ~/.lax/trusted-publishers.json to verify.",
    };
  }

  if (registeredHash) return { trustLevel: "hash-verified", currentHash };
  return {
    trustLevel: "unsigned",
    currentHash,
    warning: `Plugin "${manifest.id}" is unsigned. Loading unsigned plugins is a security risk.`,
  };
}
