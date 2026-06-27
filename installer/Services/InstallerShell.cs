using System.Diagnostics;
using System.Text;

namespace LocalAgentX.Installer.Services;

// Shared process/PATH helpers for the C# bootstrap (download → unpack → splice
// the bin dir into PATH for this run → persist it for reboot). Consumed by
// NodeBootstrap. Kept separate from it as a small, reusable utility; the
// "two places" comment in NodeBootstrap refers to C#-vs-shell (install.ps1 /
// install.bat), which genuinely can't DRY.
public static class InstallerShell
{
    // Prepend a dir to the USER PATH (HKCU) so a portable runtime survives a
    // reboot and stays visible to the desktop app. PREPENDED, not appended: an
    // older system copy already on PATH would otherwise shadow ours at runtime.
    // Avoids setx (it truncates PATH at 1024 chars) and needs no elevation.
    // Windows-only — callers reach it from inside their IsWindows() branch.
    public static void PersistUserPath(string dir)
    {
        var userPath = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "";
        if (userPath.Split(';').Contains(dir, StringComparer.OrdinalIgnoreCase)) return;
        var updated = userPath.Length == 0 ? dir : $"{dir};{userPath}";
        Environment.SetEnvironmentVariable("PATH", updated, EnvironmentVariableTarget.User);
    }

    // Prepend a dir to this process's PATH if it exists and isn't already
    // there. Child processes spawned afterward inherit the updated PATH.
    public static void SplicePath(string dir)
    {
        if (!Directory.Exists(dir)) return;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        var sep = OperatingSystem.IsWindows() ? ';' : ':';
        if (path.Split(sep).Contains(dir)) return;
        Environment.SetEnvironmentVariable("PATH", $"{dir}{sep}{path}");
    }

    public static bool HasOnPath(string cmd)
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
    public static string LastFrame(string s)
    {
        var i = s.LastIndexOf('\r');
        return i >= 0 ? s.Substring(i + 1) : s;
    }

    // Run a child process, streaming stdout+stderr to onLogLine (final-frame
    // collapsed). Returns true on exit code 0. onLogLine is optional so the
    // helper stays usable from contexts without a status sink.
    public static bool RunStreaming(string cmd, string[] args, Action<string>? onLogLine = null)
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
            p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) onLogLine?.Invoke(LastFrame(e.Data!)); };
            p.ErrorDataReceived  += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) onLogLine?.Invoke(LastFrame(e.Data!)); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode == 0;
        }
        catch (Exception ex)
        {
            onLogLine?.Invoke($"[error] {ex.Message}");
            return false;
        }
    }
}
