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
      "scripts/installer/**",
      "scripts/build-mac-installer.sh",
      "scripts/fetch-electron-bundle.mjs",
      "desktop/package.json",
      "desktop/package-lock.json",
      ".github/workflows/installer-rolling.yml",
    ]) {
      expect(trigger).toContain(`- "${path}"`);
    }
    expect(trigger).toContain("workflow_dispatch:");
  });

  it("publishes a fail-closed manifest for the exact bundled Electron runtime", () => {
    const workflow = rollingInstallerWorkflow();
    const publishJob = workflow.slice(workflow.indexOf("  publish-rolling:"));
    const download = publishJob.indexOf("uses: actions/download-artifact@");
    const checkout = publishJob.indexOf("uses: actions/checkout@");
    const generate = publishJob.indexOf("- name: Generate native runtime manifest");
    const release = publishJob.indexOf("uses: softprops/action-gh-release@");

    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(checkout);
    expect(generate).toBeGreaterThan(download);
    expect(release).toBeGreaterThan(generate);
    expect(publishJob).toContain("ref: ${{ github.sha }}");
    expect(publishJob).toContain('lock.packages?.["node_modules/electron"]?.version');
    expect(publishJob).toContain("https://releases.electronjs.org/releases.json");
    expect(publishJob).toContain("if (!response.ok)");
    expect(publishJob).toContain("if (!Array.isArray(releases))");
    expect(publishJob).toContain("entry?.version === electronVersion");
    expect(publishJob).toContain("release?.chrome");
    expect(publishJob).toContain("const versionPattern = /^\\d+(?:\\.\\d+)+$/");
    expect(publishJob).toContain(
      "const manifest = { schemaVersion: 1, electronVersion, chromiumVersion }",
    );
    expect(publishJob).toContain('writeFile("runtime-manifest.json"');
    expect(publishJob).toMatch(/files:\s+\|[\s\S]*^\s+runtime-manifest\.json$/m);
  });

  it("keeps the Ollama selection wired through the GUI and install script", () => {
    const view = readFileSync(resolve("installer/Views/MainWindow.axaml"), "utf8");
    const viewModel = readFileSync(resolve("installer/ViewModels/MainWindowViewModel.cs"), "utf8");
    const process = readFileSync(resolve("installer/Services/InstallProcess.cs"), "utf8");
    const script = readFileSync(resolve("scripts/installer/contract.mjs"), "utf8");

    expect(view).toContain('IsChecked="{Binding InstallOllama}"');
    expect(view).toContain('IsChecked="{Binding InstallOllamaMemoryModel}"');
    expect(viewModel).toContain("_process.Start(_repoRoot, _source.ResolvedCommit, InstallOllama, InstallOllamaMemoryModel)");
    expect(process).toContain('psi.Environment["LAX_INSTALL_OLLAMA"] = installOllama ? "1" : "0"');
    expect(process).toContain('psi.Environment["LAX_INSTALL_OLLAMA_MEMORY_MODEL"] = installOllamaMemoryModel ? "1" : "0"');
    expect(script).toContain('env.LAX_INSTALL_OLLAMA === "1"');
    expect(script).toContain('env.LAX_INSTALL_OLLAMA_MEMORY_MODEL === "1"');
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
    expect(canonicalPattern).toBe("^v[0-9][0-9A-Za-z._-]*$");
    expect(windowsPattern).toBe(canonicalPattern);
    expect(workflow).toContain('[[ ! "$RELEASE_TAG" =~ ^v[0-9][0-9A-Za-z._-]*$ ]]');
    const validTag = new RegExp(windowsPattern!);
    expect(validTag.test("v0.5.3")).toBe(true);
    expect(validTag.test("V0.5.3")).toBe(false);
    expect(validTag.test("v")).toBe(false);
    expect(validTag.test("vbeta")).toBe(false);
    expect(validTag.test("version-1")).toBe(false);
    expect(validTag.test("v1 bad")).toBe(false);
    expect(validTag.test("v1/other")).toBe(false);
    expect(validTag.test("v١")).toBe(false);
    expect(validTag.test("main")).toBe(false);
    expect(validTag.test("24ae723f93286018")).toBe(false);
  });

  it("checks out and embeds the same canonical tag in both installers", () => {
    const workflow = installerReleaseWorkflow();

    expect(
      workflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g),
    ).toHaveLength(1);
    expect(
      workflow.match(/ref: \$\{\{ needs\.release-gate\.outputs\.source_sha \}\}/g),
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

describe("native desktop auto-update package contract", () => {
  const desktopPackage = JSON.parse(readFileSync(resolve("desktop/package.json"), "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
    build: {
      artifactName: string;
      publish: Array<{
        provider: string;
        url: string;
        channel: string;
        useMultipleRangeRequest: boolean;
      }>;
      win: { target: string; executableName: string; sign: boolean };
      nsis: { oneClick: boolean; allowToChangeInstallationDirectory: boolean };
      mac: {
        target: string[];
        hardenedRuntime: boolean;
        entitlements: string;
        entitlementsInherit: string;
        notarize: { teamId: string };
      };
      dmg: { writeUpdateInfo: boolean };
    };
  };
  const desktopLock = JSON.parse(readFileSync(resolve("desktop/package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };

  it("uses one pinned updater runtime and stable generic GitHub feed", () => {
    const updaterVersion = desktopPackage.dependencies["electron-updater"];

    expect(updaterVersion).toBe("6.6.2");
    expect(desktopLock.packages[""].dependencies?.["electron-updater"]).toBe(updaterVersion);
    expect(desktopLock.packages["node_modules/electron-updater"].version).toBe(updaterVersion);
    expect(desktopPackage.build.publish).toEqual([{
      provider: "generic",
      url: "https://github.com/Local-Agent-X/Local-Agent-X/releases/download/desktop-stable",
      channel: "latest",
      useMultipleRangeRequest: false,
    }]);
    expect(desktopPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("emits deterministic native assets without colliding with migration installers", () => {
    expect(desktopPackage.build.artifactName)
      .toBe("Local-Agent-X-Desktop-${version}-${os}-${arch}.${ext}");
    expect(desktopPackage.build.artifactName).not.toContain("Installer");
    expect(desktopPackage.build.win.target).toBe("nsis");
    expect(desktopPackage.build.win.executableName).toBe("LocalAgentX");
    expect(desktopPackage.build.mac.target).toEqual(["dmg", "zip"]);
  });

  it("keeps updater-compatible targets and the existing signing safeguards", () => {
    expect(desktopPackage.build.nsis).toEqual({
      oneClick: true,
      allowToChangeInstallationDirectory: false,
    });
    expect(desktopPackage.build.mac.hardenedRuntime).toBe(true);
    expect(desktopPackage.build.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(desktopPackage.build.mac.entitlementsInherit).toBe("build/entitlements.mac.plist");
    expect(desktopPackage.build.mac.notarize.teamId).toBe("CHV92LAWAZ");
    expect(desktopPackage.build.dmg.writeUpdateInfo).toBe(false);
    expect(desktopPackage.build.win.sign).toBe(false);
  });
});

describe("signed native desktop rolling release contract", () => {
  const workflow = rollingInstallerWorkflow();
  const windows = windowsJob(".github/workflows/installer-rolling.yml");
  const macStart = workflow.indexOf("  build-macos-rolling:");
  const publishStart = workflow.indexOf("  publish-rolling:");
  const mac = workflow.slice(macStart, publishStart);
  const publish = workflow.slice(publishStart);

  it("rebuilds both native platforms whenever shipped desktop code changes", () => {
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\npermissions:"));

    expect(trigger).toContain('- "desktop/src/**"');
    expect(trigger).toContain('- "desktop/build/**"');
    expect(windows).toContain("npm --prefix .. ci");
    expect(mac).toContain("npm --prefix .. ci");
    expect(windows).toContain("electron-builder --win nsis --x64 --publish never");
    expect(mac).toContain("electron-builder --mac dmg zip --arm64 --publish never");
  });

  it("has electron-builder sign Windows bytes before it creates publishable metadata", () => {
    const build = windows.indexOf("electron-builder --win nsis --x64 --publish never");
    const verify = windows.indexOf("Verify signed Windows desktop package before publishing metadata");
    const upload = windows.indexOf("uses: actions/upload-artifact@");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(verify);
    expect(windows).toContain("AZURE_TENANT_ID: ${{ secrets.AZURE_SIGN_TENANT_ID }}");
    expect(windows).toContain("AZURE_CLIENT_ID: ${{ secrets.AZURE_SIGN_CLIENT_ID }}");
    expect(windows).toContain("AZURE_CLIENT_SECRET: ${{ secrets.AZURE_SIGN_CLIENT_SECRET }}");
    expect(windows).toContain("--config.win.azureSignOptions.endpoint=");
    expect(windows).toContain("--config.win.azureSignOptions.certificateProfileName=");
    expect(windows).toContain("--config.win.azureSignOptions.codeSigningAccountName=");
    expect(windows).toContain('desktop/release/win-unpacked/LocalAgentX.exe');
    expect(windows).toContain('foreach ($path in @($installedExecutable, $expectedPackage))');
    expect(windows).toContain("$sig.Status -ne 'Valid'");
    expect(windows).toContain("$null -eq $sig.TimeStamperCertificate");
    expect(windows).toContain("$sig.SignerCertificate.Subject -cne $env:WIN_SIGN_EXPECTED_SUBJECT");
    expect(windows).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
  });

  it("fails closed unless the macOS app is Developer ID signed and notarized", () => {
    const build = mac.indexOf("electron-builder --mac dmg zip --arm64 --publish never");
    const verify = mac.indexOf("Verify signed and notarized macOS desktop package before publishing metadata");
    const upload = mac.indexOf("uses: actions/upload-artifact@");

    expect(mac).toContain("- name: Require macOS release signing configuration");
    expect(mac).toContain("MAC_EXPECTED_TEAM_ID");
    expect(mac).toContain("MACOS_SIGN_IDENTITY: ${{ secrets.MACOS_SIGN_IDENTITY }}");
    expect(mac).toContain('export CSC_NAME="${MACOS_SIGN_IDENTITY#Developer ID Application: }"');
    expect(mac).toContain('export APPLE_API_KEY="$API_KEY_PATH"');
    expect(mac).toContain("APPLE_API_KEY_ID: ${{ secrets.MACOS_API_KEY_ID }}");
    expect(mac).toContain("APPLE_API_ISSUER: ${{ secrets.MACOS_API_ISSUER_ID }}");
    expect(verify).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(verify);
    expect(mac).toContain("codesign --verify --deep --strict");
    expect(mac).toContain('if [ "$GOT" != "$MAC_EXPECTED_TEAM_ID" ]');
    expect(mac).toContain('xcrun stapler validate "$APP"');
    expect(mac).toContain('spctl --assess --type execute --verbose=2 "$APP"');
    expect(mac).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
  });

  it("publishes one fixed update feed only after both signed platform jobs succeed", () => {
    const stable = publish.indexOf("- name: Publish signed native desktop update feed");
    const rolling = publish.indexOf("- name: Publish/refresh the `rolling` pre-release");

    expect(publish).toContain("needs: [build-windows-rolling, build-macos-rolling]");
    expect(stable).toBeGreaterThanOrEqual(0);
    expect(rolling).toBeGreaterThan(stable);
    expect(publish).toContain("tag_name: desktop-stable");
    expect(publish).toContain("make_latest: false");
    for (const asset of [
      "Local-Agent-X-Desktop-*-win-x64.exe",
      "Local-Agent-X-Desktop-*-win-x64.exe.blockmap",
      "latest.yml",
      "Local-Agent-X-Desktop-*-mac-arm64.zip",
      "Local-Agent-X-Desktop-*-mac-arm64.zip.blockmap",
      "Local-Agent-X-Desktop-*-mac-arm64.dmg",
      "latest-mac.yml",
    ]) {
      expect(publish).toContain(asset);
    }
    expect(publish).toContain("tag_name: rolling");
    expect(publish).toContain("Install Local Agent X Windows Installer.exe");
    expect(publish).toContain("Install Local Agent X Mac Installer.dmg");
  });
});
