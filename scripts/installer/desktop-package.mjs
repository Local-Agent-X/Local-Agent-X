import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DESKTOP_FEED_ROOT =
  "https://github.com/Local-Agent-X/Local-Agent-X/releases/download/desktop-stable";

function parseMetadata(text) {
  const version = text.match(/^version:\s*['"]?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)['"]?\s*$/m)?.[1];
  if (!version) throw new Error("Desktop update metadata has no valid version.");
  const files = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const url = lines[index].match(/^\s*-\s+url:\s*['"]?([^'"]+?)['"]?\s*$/)?.[1];
    if (!url) continue;
    const sha512 = lines.slice(index + 1, index + 6)
      .map((line) => line.match(/^\s+sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?\s*$/)?.[1])
      .find(Boolean);
    if (!sha512) throw new Error(`Desktop update metadata has no SHA-512 for ${url}.`);
    if (Buffer.from(sha512, "base64").length !== 64) {
      throw new Error(`Desktop update metadata has an invalid SHA-512 for ${url}.`);
    }
    files.push({ url, sha512 });
  }
  if (files.length === 0) throw new Error("Desktop update metadata has no files.");
  return { version, files };
}

function expectedArtifact(version, platform, arch) {
  const os = platform === "darwin" ? "mac" : "win";
  const extension = platform === "darwin" ? "zip" : "exe";
  return `Local-Agent-X-Desktop-${version}-${os}-${arch}.${extension}`;
}

async function fetchOk(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Desktop package request failed (${response.status}) for ${url}.`);
  return response;
}

export async function acquireDesktopPackage({
  platform,
  arch,
  fetchImpl = globalThis.fetch,
  temporaryRoot = tmpdir(),
}) {
  if (!["darwin", "win32"].includes(platform)) throw new Error(`Unsupported desktop package platform: ${platform}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported desktop package architecture: ${arch}`);
  if (typeof fetchImpl !== "function") throw new Error("HTTPS download support is unavailable.");
  const metadataName = platform === "darwin" ? "latest-mac.yml" : "latest.yml";
  const metadataUrl = `${DESKTOP_FEED_ROOT}/${metadataName}`;
  const metadataResponse = await fetchOk(metadataUrl, fetchImpl);
  const metadata = parseMetadata(await metadataResponse.text());
  const artifactName = expectedArtifact(metadata.version, platform, arch);
  const entry = metadata.files.find((file) => file.url === artifactName);
  if (!entry) throw new Error(`Desktop metadata does not contain the expected ${artifactName}.`);
  if (basename(entry.url) !== entry.url || entry.url.includes("..") || /[\\/]/.test(entry.url)) {
    throw new Error("Desktop metadata contains an unsafe package path.");
  }

  const packageUrl = `${DESKTOP_FEED_ROOT}/${encodeURIComponent(artifactName)}`;
  const response = await fetchOk(packageUrl, fetchImpl);
  if (!response.body) throw new Error("Desktop package response has no body.");
  const directory = mkdtempSync(join(temporaryRoot, "lax-desktop-"));
  const packagePath = join(directory, artifactName);
  const hash = createHash("sha512");
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => hash.update(chunk));
  try {
    await pipeline(source, createWriteStream(packagePath, { mode: 0o600, flags: "wx" }));
    const actual = hash.digest("base64");
    if (actual !== entry.sha512) throw new Error("Desktop package SHA-512 verification failed.");
    return {
      version: metadata.version,
      packagePath,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
