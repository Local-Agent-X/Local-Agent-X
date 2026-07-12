using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;

namespace LocalAgentX.Installer.Services;

// Node bootstrap — runs BEFORE install-common.mjs because that script needs
// Node to execute. Chicken-and-egg: we can't move this step into
// install-common.mjs itself. Lives in the C# GUI installer (here) and in
// install.bat / install.sh / install.ps1 for CLI users — same logic in two
// places, both small enough that DRY would cost more than copy-paste.
public class NodeBootstrap
{
    public event Action<string>? OnStatus;   // human-readable status line
    public event Action<string>? OnLogLine;  // raw winget/brew output

    // The app's Node floor — keep in sync with NODE_MAJOR_MIN in
    // scripts/install-common.mjs (and the version checks in install.sh /
    // install.ps1). Version-aware so a user BELOW the floor gets an upgrade
    // here instead of a hard "Node 22+ required" failure from
    // install-common.mjs later — and so a future floor raise auto-upgrades
    // existing users the next time they run an installer.
    private const int NODE_MAJOR_MIN = 22;

    // Portable-zip fallback version when winget can't deliver Node. Keep in
    // sync with the pinned URL in install.ps1.
    private const string NODE_FALLBACK_VERSION = "24.16.0";

    public bool NodeAvailable()
    {
        return NodeMajorVersion() >= NODE_MAJOR_MIN;
    }

    // Major version of the `node` on PATH, or -1 if absent/unparseable.
    // Running `node -v` proves presence AND gets the version in one call.
    static int NodeMajorVersion()
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "-v",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            var output = p!.StandardOutput.ReadToEnd().Trim(); // e.g. "v22.12.0"
            p.WaitForExit(3000);
            if (p.ExitCode != 0) return -1;
            return int.TryParse(output.TrimStart('v').Split('.')[0], out var major) ? major : -1;
        }
        catch { return -1; }
    }

    // Returns true on success, false if install failed.
    public bool InstallNode()
    {
        OnStatus?.Invoke("Installing Node.js 24 (LTS)…");
        if (OperatingSystem.IsWindows())
        {
            // Portable ZIP FIRST — parity with the macOS branch below. The ZIP
            // unpacks to %LOCALAPPDATA% and persists to the USER PATH, so it needs
            // no elevation and works on locked-down machines with no winget / App
            // Installer at all. winget's OpenJS.NodeJS.LTS package installs
            // machine-wide and needs a UAC elevation prompt the installer can't
            // raise when it isn't itself elevated — that path silently failed with
            // exit 1602 ("user cancelled") and NO visible prompt. winget stays
            // only as a fallback for when the ZIP download itself fails.
            InstallNodeFromZip();
            if (NodeAvailable()) return true;

            OnStatus?.Invoke("Portable Node download failed — trying winget…");
            // winget's exit code is unreliable — it returns benign non-zero codes
            // (e.g. 0x8A150011 "no applicable upgrade found") and can report
            // failure even when the package installed. Don't gate on it; splice
            // its install dir into THIS process's PATH (it won't auto-refresh) and
            // let the final NodeAvailable() check be the single source of truth.
            // No --disable-interactivity: if winget must elevate to install
            // machine-wide, it needs to be able to raise the UAC prompt rather
            // than silently 1602 with no prompt shown.
            RunStreaming("winget", new[] {
                "install", "OpenJS.NodeJS.LTS",
                "--accept-package-agreements", "--accept-source-agreements",
                "--silent",
            });
            SpliceNodeDir();
            return NodeAvailable();
        }
        if (OperatingSystem.IsMacOS())
        {
            // Portable official Node FIRST — see desktop/src/node-runtime.ts:
            // brew's node is ad-hoc signed, so its macOS TCC grants (Documents,
            // Screen Recording, Accessibility) die on every `brew upgrade`. The
            // official build is self-contained + Developer-ID signed, so the
            // grant survives. Provision it into ~/.lax/runtime (where the desktop
            // runtime resolves it). brew stays only as a last-resort fallback.
            if (InstallNodeFromTarball()) return true;
            OnStatus?.Invoke("Portable Node download failed — falling back to Homebrew…");
            if (!HasOnPath("brew"))
            {
                OnStatus?.Invoke("Installing Homebrew…");
                // NONINTERACTIVE=1: the installer runs with no tty, so Homebrew's
                // "Press RETURN to continue" prompt would hang it forever. (It can
                // still fail if first-time /opt/homebrew creation needs a sudo
                // password — that path requires the user to have brew or admin.)
                var brewOk = RunStreaming("/bin/bash", new[] {
                    "-c", "NONINTERACTIVE=1 /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
                });
                if (!brewOk) return false;
                // The Homebrew installer writes to /opt/homebrew/bin (Apple
                // Silicon) or /usr/local/bin (Intel), but our process PATH was
                // captured before that dir existed — splice it in so the brew
                // calls below resolve without re-launching the app.
                InstallerShell.SplicePath("/opt/homebrew/bin");
                InstallerShell.SplicePath("/usr/local/bin");
            }
            var nodeOk = RunStreaming("brew", new[] { "install", "node@24" });
            if (!nodeOk) return false;
            RunStreaming("brew", new[] { "link", "--overwrite", "--force", "node@24" });
            return true;
        }
        // Linux
        OnStatus?.Invoke("Installing Node 24 via apt…");
        RunStreaming("/bin/bash", new[] { "-c", "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" });
        return RunStreaming("sudo", new[] { "apt-get", "install", "-y", "nodejs" });
    }

    // winget installs to Program Files\nodejs; splice it into this process's
    // PATH so the upcoming `node -v` verify and the install-common.mjs spawn
    // can find it without a relaunch. (The zip fallback splices its own dir.)
    static void SpliceNodeDir()
    {
        InstallerShell.SplicePath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
    }

    // Primary Windows Node path: download the official Windows ZIP (not the MSI)
    // and unpack it to a per-user dir. No admin and no winget required — the old
    // MSI path ran `msiexec /qn` to install machine-wide under Program Files,
    // which needs elevation the installer doesn't request, so it failed silently
    // on machines without App Installer. The caller verifies success via
    // NodeAvailable() afterward and only falls back to winget if this fails.
    bool InstallNodeFromZip()
    {
        // Match the host CPU — Windows on ARM (Surface Pro X, Snapdragon laptops)
        // can't run the x64 node.exe natively. node ships a win-arm64 build.
        var arch = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";
        var pkg = $"node-v{NODE_FALLBACK_VERSION}-{arch}";
        var zip = Path.Combine(Path.GetTempPath(), $"{pkg}.zip");
        var installRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalAgentX");
        var nodeDir = Path.Combine(installRoot, pkg);
        try
        {
            var url = $"https://nodejs.org/dist/v{NODE_FALLBACK_VERSION}/{pkg}.zip";
            OnLogLine?.Invoke($"Downloading {url}");
            using (var http = new HttpClient())
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");
                File.WriteAllBytes(zip, http.GetByteArrayAsync(url).GetAwaiter().GetResult());
            }
            OnStatus?.Invoke("Unpacking the Node.js runtime…");
            Directory.CreateDirectory(installRoot);
            if (Directory.Exists(nodeDir)) Directory.Delete(nodeDir, true);
            ZipFile.ExtractToDirectory(zip, installRoot);
            // Portable runtime: make it findable now (this process) and at
            // runtime/reboot (persisted to the user PATH — no admin needed).
            InstallerShell.SplicePath(nodeDir);
            InstallerShell.PersistUserPath(nodeDir);
            return true;
        }
        catch (Exception ex)
        {
            OnLogLine?.Invoke($"[error] Node portable runtime fallback failed: {ex.Message}");
            return false;
        }
        finally
        {
            try { File.Delete(zip); } catch { }
        }
    }

    // macOS counterpart of InstallNodeFromZip: download the official, self-
    // contained darwin tarball and extract it to ~/.lax/runtime — the stable,
    // Developer-ID-signed Node the desktop runtime resolves first (server-
    // process.ts prepends ~/.lax/runtime/bin to PATH). Writes the same
    // .node-version sentinel node-runtime.ts reads.
    bool InstallNodeFromTarball()
    {
        var arch = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        var pkg = $"node-v{NODE_FALLBACK_VERSION}-darwin-{arch}";
        var tgz = Path.Combine(Path.GetTempPath(), $"{pkg}.tar.gz");
        var runtimeDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lax", "runtime");
        try
        {
            var url = $"https://nodejs.org/dist/v{NODE_FALLBACK_VERSION}/{pkg}.tar.gz";
            OnLogLine?.Invoke($"Downloading {url}");
            using (var http = new HttpClient())
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");
                File.WriteAllBytes(tgz, http.GetByteArrayAsync(url).GetAwaiter().GetResult());
            }
            OnStatus?.Invoke("Unpacking the Node.js runtime…");
            if (Directory.Exists(runtimeDir)) Directory.Delete(runtimeDir, true);
            Directory.CreateDirectory(runtimeDir);
            // tar ships on every macOS; --strip-components=1 drops the version
            // dir so node lands at ~/.lax/runtime/bin/node.
            if (!RunStreaming("/usr/bin/tar", new[] { "-xzf", tgz, "-C", runtimeDir, "--strip-components=1" }))
                return false;
            File.WriteAllText(Path.Combine(runtimeDir, ".node-version"), NODE_FALLBACK_VERSION);
            InstallerShell.SplicePath(Path.Combine(runtimeDir, "bin"));
            return File.Exists(Path.Combine(runtimeDir, "bin", "node"));
        }
        catch (Exception ex)
        {
            OnLogLine?.Invoke($"[error] portable Node provision failed: {ex.Message}");
            return false;
        }
        finally
        {
            try { File.Delete(tgz); } catch { }
        }
    }

    // PATH/process helpers live in InstallerShell. These thin wrappers forward
    // this bootstrap's OnLogLine sink so the call sites below read unchanged.
    bool RunStreaming(string cmd, string[] args) => InstallerShell.RunStreaming(cmd, args, OnLogLine);
    bool HasOnPath(string cmd) => InstallerShell.HasOnPath(cmd);
}
