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

function installerReleaseWorkflow(): string {
  return readFileSync(resolve(".github/workflows/installer-release.yml"), "utf8");
}

function rollingInstallerWorkflow(): string {
  return readFileSync(resolve(".github/workflows/installer-rolling.yml"), "utf8");
}

describe("rolling installer freshness contract", () => {
  it("rebuilds when the compiled installer or install-script contract changes", () => {
    const workflow = rollingInstallerWorkflow();
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\npermissions:"));

    expect(trigger).toMatch(/push:\s+branches:\s+- main/);
    for (const path of [
      "installer/**",
      "scripts/install-common.mjs",
      "scripts/build-mac-installer.sh",
      "scripts/fetch-electron-bundle.mjs",
      ".github/workflows/installer-rolling.yml",
    ]) {
      expect(trigger).toContain(`- "${path}"`);
    }
    expect(trigger).toContain("workflow_dispatch:");
  });

  it("keeps the Ollama selection wired through the GUI and install script", () => {
    const view = readFileSync(resolve("installer/Views/MainWindow.axaml"), "utf8");
    const viewModel = readFileSync(resolve("installer/ViewModels/MainWindowViewModel.cs"), "utf8");
    const process = readFileSync(resolve("installer/Services/InstallProcess.cs"), "utf8");
    const script = readFileSync(resolve("scripts/install-common.mjs"), "utf8");

    expect(view).toContain('IsChecked="{Binding InstallOllama}"');
    expect(viewModel).toContain("_process.Start(_repoRoot, _source.ResolvedCommit, InstallOllama)");
    expect(process).toContain('psi.Environment["LAX_INSTALL_OLLAMA"] = installOllama ? "1" : "0"');
    expect(script).toContain('process.env.LAX_INSTALL_OLLAMA === "1"');
  });
});

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

describe("versioned installer release tag contract", () => {
  it("requires an explicit existing tag for manual rebuilds", () => {
    const workflow = installerReleaseWorkflow();
    const installerProject = readFileSync(resolve("installer/Installer.csproj"), "utf8");
    const canonicalPattern = installerProject.match(
      /Regex\]::IsMatch\('\$\(InstallerSourceTag\)', '([^']+)'\)/,
    )?.[1];
    const windowsPattern = workflow.match(
      /\$env:RELEASE_TAG -cnotmatch '([^']+)'/,
    )?.[1];

    expect(workflow).toMatch(/push:\s+tags:\s+- 'v\*'/);
    expect(workflow).toMatch(
      /workflow_dispatch:\s+inputs:\s+tag:\s+description: [^\n]*lowercase v followed by a digit[^\n]*\s+required: true\s+type: string/,
    );
    expect(workflow).toContain("RELEASE_TAG: ${{ inputs.tag || github.ref_name }}");
    expect(canonicalPattern).toBe("^v[0-9]");
    expect(windowsPattern).toBe(canonicalPattern);
    expect(workflow).toContain('[[ ! "$RELEASE_TAG" =~ ^v[0-9] ]]');
    const validTag = new RegExp(windowsPattern!);
    expect(validTag.test("v0.5.3")).toBe(true);
    expect(validTag.test("V0.5.3")).toBe(false);
    expect(validTag.test("v")).toBe(false);
    expect(validTag.test("vbeta")).toBe(false);
    expect(validTag.test("version-1")).toBe(false);
    expect(validTag.test("v١")).toBe(false);
    expect(validTag.test("main")).toBe(false);
    expect(validTag.test("24ae723f93286018")).toBe(false);
  });

  it("checks out and embeds the same canonical tag in both installers", () => {
    const workflow = installerReleaseWorkflow();

    expect(
      workflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g),
    ).toHaveLength(2);
    expect(workflow).not.toMatch(/^\s+ref: \$\{\{ env\.RELEASE_TAG \}\}$/m);
    expect(workflow).toContain("-p:InstallerSourceTag=$env:RELEASE_TAG");
    expect(workflow).toContain("INSTALLER_SOURCE_TAG: ${{ env.RELEASE_TAG }}");
    expect(workflow).not.toContain("InstallerSourceTag=${{ github.ref_name }}");
    expect(workflow).not.toContain("INSTALLER_SOURCE_TAG: ${{ github.ref_name }}");
  });

  it("attaches signed artifacts to that exact versioned release", () => {
    const workflow = installerReleaseWorkflow();
    const attachJob = workflow.slice(workflow.indexOf("  attach-to-release:"));

    expect(attachJob).toContain("tag_name: ${{ env.RELEASE_TAG }}");
    expect(attachJob).toContain("make_latest: false");
    expect(attachJob).toContain(
      "dist/windows-installer/Install Local Agent X Windows Installer.exe",
    );
    expect(attachJob).toContain(
      "dist/macos-installer/Install Local Agent X Mac Installer.dmg",
    );
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
