using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
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

    public bool NodeAvailable()
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo
            {
                FileName = OperatingSystem.IsWindows() ? "where" : "command",
                Arguments = OperatingSystem.IsWindows() ? "node" : "-v node",
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

    // Returns true on success, false if install failed.
    public bool InstallNode()
    {
        OnStatus?.Invoke("Installing Node.js 22…");
        if (OperatingSystem.IsWindows())
        {
            var ok = RunStreaming("winget", new[] {
                "install", "OpenJS.NodeJS.LTS",
                "--accept-package-agreements", "--accept-source-agreements",
                "--silent", "--disable-interactivity",
            });
            if (!ok) return false;
            // winget installs to Program Files\nodejs but our PATH won't auto-
            // refresh inside this process. Splice it in for the upcoming
            // spawn of node install-common.mjs --ipc.
            var nodeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs");
            if (Directory.Exists(nodeDir))
            {
                var path = Environment.GetEnvironmentVariable("PATH") ?? "";
                Environment.SetEnvironmentVariable("PATH", $"{nodeDir};{path}");
            }
            return true;
        }
        if (OperatingSystem.IsMacOS())
        {
            // brew first (install if missing), then node@22.
            if (!HasOnPath("brew"))
            {
                OnStatus?.Invoke("Installing Homebrew…");
                var brewOk = RunStreaming("/bin/bash", new[] {
                    "-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
                });
                if (!brewOk) return false;
                // The Homebrew installer writes to /opt/homebrew/bin (Apple
                // Silicon) or /usr/local/bin (Intel), but our process PATH was
                // captured before that dir existed — splice it in so the brew
                // calls below resolve without re-launching the app.
                SplicePath("/opt/homebrew/bin");
                SplicePath("/usr/local/bin");
            }
            var nodeOk = RunStreaming("brew", new[] { "install", "node@22" });
            if (!nodeOk) return false;
            RunStreaming("brew", new[] { "link", "--overwrite", "--force", "node@22" });
            return true;
        }
        // Linux
        OnStatus?.Invoke("Installing Node 22 via apt…");
        RunStreaming("/bin/bash", new[] { "-c", "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" });
        return RunStreaming("sudo", new[] { "apt-get", "install", "-y", "nodejs" });
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

    bool RunStreaming(string cmd, string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = cmd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi)!;
            p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) OnLogLine?.Invoke(e.Data!); };
            p.ErrorDataReceived  += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) OnLogLine?.Invoke(e.Data!); };
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
