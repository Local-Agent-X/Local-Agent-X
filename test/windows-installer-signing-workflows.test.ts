import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflows = [
  ".github/workflows/installer-release.yml",
  ".github/workflows/installer-rolling.yml",
] as const;

function windowsJob(path: string): string {
  const workflow = readFileSync(resolve(path), "utf8");
  const start = workflow.indexOf("  build-windows");
  const end = workflow.indexOf("\n  build-macos", start);
  expect(start, `${path} has a Windows build job`).toBeGreaterThanOrEqual(0);
  expect(end, `${path} has a macOS job after Windows`).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe.each(workflows)("%s Windows release signing", (path) => {
  it("requires every signing input before building", () => {
    const job = windowsJob(path);
    const gate = job.indexOf("- name: Require Windows release signing configuration");
    const build = job.indexOf("dotnet publish installer/Installer.csproj");

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(build);
    expect(job).toContain("if ($missing.Count -gt 0)");
    expect(job).toContain("Windows release signing configuration is incomplete");
    expect(job).toContain("exit 1");
    for (const setting of [
      "AZURE_SIGN_TENANT_ID",
      "AZURE_SIGN_CLIENT_ID",
      "AZURE_SIGN_CLIENT_SECRET",
      "AZURE_SIGN_ENDPOINT",
      "AZURE_SIGN_ACCOUNT",
      "AZURE_SIGN_CERT_PROFILE",
      "WIN_SIGN_EXPECTED_SUBJECT",
    ]) {
      expect(job).toContain(`${setting} = $env:${setting}`);
    }
  });

  it("signs and verifies before the only artifact upload", () => {
    const job = windowsJob(path);
    const sign = job.indexOf("uses: azure/artifact-signing-action@v2");
    const verify = job.indexOf("- name: Verify signing identity (fail-closed on cert drift)");
    const upload = job.indexOf("uses: actions/upload-artifact@");

    expect(sign).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(sign);
    expect(upload).toBeGreaterThan(verify);
    expect(job.indexOf("uses: actions/upload-artifact@", upload + 1)).toBe(-1);
    expect(job).not.toMatch(/\n\s+if:.*AZURE_SIGN/);
  });

  it("requires a valid timestamped signature and exact expected subject", () => {
    const job = windowsJob(path);

    expect(job).toContain("$sig.Status -ne 'Valid'");
    expect(job).toContain("$null -eq $sig.TimeStamperCertificate");
    expect(job).toContain("$subj -cne $want");
    expect(job).not.toContain("$subj -notlike");
    expect(job).toContain("timestamp-rfc3161: http://timestamp.acs.microsoft.com");
    expect(job).toContain("timestamp-digest: SHA256");
  });
});

it("retains unsigned local desktop packaging as the development path", () => {
  const desktopPackage = JSON.parse(readFileSync(resolve("desktop/package.json"), "utf8")) as {
    scripts: Record<string, string>;
    build: { win: { sign: boolean } };
  };

  expect(desktopPackage.build.win.sign).toBe(false);
  expect(desktopPackage.scripts.pack).toContain("electron-builder --dir");
  expect(desktopPackage.scripts.dist).toContain("electron-builder");
});
