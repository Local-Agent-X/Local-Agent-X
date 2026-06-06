using System;
using System.Diagnostics;
using System.IO;
using Avalonia;

namespace LocalAgentX.Installer;

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        FixPathForGuiLaunch();
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() => AppBuilder
        .Configure<App>()
        .UsePlatformDetect()
        .WithInterFont()
        .LogToTrace();

    // macOS/Linux GUI launch fix. A .app double-clicked in Finder inherits
    // launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) — NOT the user's
    // shell PATH. So Homebrew tools (node, npm, brew, ollama in /opt/homebrew/bin)
    // are invisible to every child Process.Start, and the installer wrongly
    // concludes "node missing" then fails trying to bootstrap it. We repair the
    // process PATH up front (inherited by all children, including the node child
    // that runs install-common.mjs and ITS brew/ollama/npm spawns) by asking the
    // user's login shell for its PATH, then unioning in the well-known dirs as a
    // belt-and-suspenders fallback.
    private static void FixPathForGuiLaunch()
    {
        if (OperatingSystem.IsWindows()) return;

        var current = Environment.GetEnvironmentVariable("PATH") ?? "";
        var parts = new System.Collections.Generic.List<string>(
            current.Split(':', StringSplitOptions.RemoveEmptyEntries));
        var seen = new System.Collections.Generic.HashSet<string>(parts);

        void Prepend(string dir)
        {
            if (string.IsNullOrEmpty(dir) || seen.Contains(dir)) return;
            if (!Directory.Exists(dir)) return;
            parts.Insert(0, dir);
            seen.Add(dir);
        }

        // 1) Pull the login shell's PATH — captures Homebrew, nvm, asdf, fnm,
        //    volta, and any custom user setup. Best-effort; ignore failures.
        try
        {
            var shell = Environment.GetEnvironmentVariable("SHELL");
            if (string.IsNullOrEmpty(shell) || !File.Exists(shell)) shell = "/bin/zsh";
            var psi = new ProcessStartInfo
            {
                FileName = shell,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            // -l: login shell (sources profile); -i: interactive (sources rc);
            // -c: run command. Together they reproduce a terminal's PATH.
            psi.ArgumentList.Add("-lic");
            psi.ArgumentList.Add("echo __LAXPATH__:$PATH");
            using var p = Process.Start(psi);
            if (p != null)
            {
                // Read on a background task so a misbehaving rc file that never
                // returns can't hang app startup — bail after the timeout and
                // fall back to the static dir list below.
                var readTask = p.StandardOutput.ReadToEndAsync();
                if (!p.WaitForExit(4000)) { try { p.Kill(true); } catch { } }
                var outp = readTask.Wait(1000) ? readTask.Result : "";
                foreach (var line in outp.Split('\n'))
                {
                    var idx = line.IndexOf("__LAXPATH__:", StringComparison.Ordinal);
                    if (idx < 0) continue;
                    var shellPath = line.Substring(idx + "__LAXPATH__:".Length).Trim();
                    // Prepend shell-path entries in order so they take priority.
                    var shellParts = shellPath.Split(':', StringSplitOptions.RemoveEmptyEntries);
                    for (int i = shellParts.Length - 1; i >= 0; i--) Prepend(shellParts[i]);
                    break;
                }
            }
        }
        catch { /* fall through to the static dir list below */ }

        // 2) Belt-and-suspenders: the canonical Homebrew + local bin dirs.
        Prepend("/usr/local/sbin");
        Prepend("/usr/local/bin");
        Prepend("/opt/homebrew/sbin");
        Prepend("/opt/homebrew/bin");

        Environment.SetEnvironmentVariable("PATH", string.Join(':', parts));
    }
}
