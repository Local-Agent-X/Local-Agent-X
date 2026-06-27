import { describe, it, expect } from "vitest";
import {
  GIT_PORTABLE_VERSION,
  GIT_PORTABLE_SHA256,
  portableGitAssetName,
  portableGitDownloadUrl,
  portableGitExtractDir,
} from "../scripts/portable-git.mjs";

// The pinned PortableGit release is provisioned by scripts/install-common.mjs,
// and its extract path is byte-coupled to src/tools/shell-env.ts
// portableGitBashPath. These lock the trap doors: the tag-vs-version URL
// mismatch and the SFX's fixed "PortableGit" extract leaf.
describe("portable-git pins + builders", () => {
  it("asset name matches the published asset format", () => {
    expect(portableGitAssetName("2.54.0")).toBe("PortableGit-2.54.0-64-bit.7z.exe");
  });

  it("download URL uses the v{VER}.windows.1 tag but the bare-version asset", () => {
    expect(portableGitDownloadUrl("2.54.0")).toBe(
      "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-64-bit.7z.exe",
    );
  });

  it("download URL defaults to the pinned version", () => {
    expect(portableGitDownloadUrl()).toContain(`v${GIT_PORTABLE_VERSION}.windows.1`);
    expect(portableGitDownloadUrl()).toContain(portableGitAssetName());
  });

  it("extract dir leaf is PortableGit under LocalAgentX (coupled to shell-env)", () => {
    const dir = portableGitExtractDir("C:\\Users\\x\\AppData\\Local").replace(/\//g, "\\");
    expect(dir).toBe("C:\\Users\\x\\AppData\\Local\\LocalAgentX\\PortableGit");
  });

  it("SHA256 is a lowercase 64-hex digest", () => {
    expect(GIT_PORTABLE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
