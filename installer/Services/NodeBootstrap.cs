using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;

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
            // winget's exit code is unreliable — it returns benign non-zero
            // codes (e.g. 0x8A150011 "no applicable upgrade found") and can
            // report failure even when the package installed. Don't gate on it.
            // Run winget, splice the install dir into THIS process's PATH (it
            // won't auto-refresh), then verify the actual goal: a node >= floor
            // on PATH. Only if that's still missing do we fall back to the
            // official MSI (parity with install.ps1) and re-verify. The final
            // NodeAvailable() check is the single source of truth.
            RunStreaming("winget", new[] {
                "install", "OpenJS.NodeJS.LTS",
                "--accept-package-agreements", "--accept-source-agreements",
                "--silent", "--disable-interactivity",
            });
            SpliceNodeDir();
            if (NodeAvailable()) return true;

            OnStatus?.Invoke("winget didn't deliver Node — downloading the portable runtime…");
            InstallNodeFromZip();
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
                SplicePath("/opt/homebrew/bin");
                SplicePath("/usr/local/bin");
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
        SplicePath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
    }

    // Fallback when winget can't deliver Node: download the official Windows
    // ZIP (not the MSI) and unpack it to a per-user dir. No admin and no winget
    // required — the old MSI path ran `msiexec /qn` to install machine-wide
    // under Program Files, which needs elevation the installer doesn't request,
    // so it failed silently on machines without App Installer. The caller
    // verifies success via NodeAvailable() afterward.
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
            SplicePath(nodeDir);
            PersistUserPath(nodeDir);
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
            SplicePath(Path.Combine(runtimeDir, "bin"));
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

    // Persist a dir to the USER PATH (HKCU) so node survives a reboot and stays
    // visible to the desktop app. PREPENDED, not appended: a user with an older
    // system Node already on PATH would otherwise shadow ours at runtime, the
    // desktop node-floor gate would trip, and its winget-based --upgrade-node
    // would fail on the very machines that lacked winget to begin with. Avoids
    // setx (it truncates PATH at 1024 chars) and needs no elevation. Windows-only
    // — the User target is only reached from inside the IsWindows() branch above.
    static void PersistUserPath(string dir)
    {
        var userPath = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "";
        if (userPath.Split(';').Contains(dir, StringComparer.OrdinalIgnoreCase)) return;
        var updated = userPath.Length == 0 ? dir : $"{dir};{userPath}";
        Environment.SetEnvironmentVariable("PATH", updated, EnvironmentVariableTarget.User);
    }

    // Prepend a dir to this process's PATH if it exists and isn't already
    // there. Child processes spawned afterward inherit the updated PATH.
    static void SplicePath(string dir)
    {
        if (!Directory.Exists(dir)) return;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        var sep = OperatingSystem.IsWindows() ? ';' : ':';
        if (path.Split(sep).Contains(dir)) return;
        Environment.SetEnvironmentVariable("PATH", $"{dir}{sep}{path}");
    }

    bool HasOnPath(string cmd)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo
            {
                FileName = OperatingSystem.IsWindows() ? "where" : "command",
                Arguments = OperatingSystem.IsWindows() ? cmd : $"-v {cmd}",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            p!.WaitForExit(3000);
            return p.ExitCode == 0;
        }
        catch { return false; }
    }

    // winget/msiexec animate progress by redrawing one line with bare carriage
    // returns (\r, no newline). When that whole burst arrives as a single
    // OutputDataReceived "line", keep only the final frame (text after the last
    // \r) so the log shows the last rendered state — not dozens of concatenated
    // redraw frames piled into one wall.
    static string LastFrame(string s)
    {
        var i = s.LastIndexOf('\r');
        return i >= 0 ? s.Substring(i + 1) : s;
    }

    bool RunStreaming(string cmd, string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = cmd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // winget emits its progress bar with UTF-8 block glyphs (█ ▒ ░).
            // Without forcing UTF-8 here, .NET decodes the stream with the
            // console's ANSI codepage (CP1252 on Windows), turning every glyph
            // into mojibake (█ → "â–ˆ") — which is what buried the real Node
            // install error in an unreadable wall of symbols. Matches the
            // encoding InstallProcess.cs already sets on the IPC stream.
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi)!;
            p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) OnLogLine?.Invoke(LastFrame(e.Data!)); };
            p.ErrorDataReceived  += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) OnLogLine?.Invoke(LastFrame(e.Data!)); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode == 0;
        }
        catch (Exception ex)
        {
            OnLogLine?.Invoke($"[error] {ex.Message}");
            return false;
        }
    }
}
