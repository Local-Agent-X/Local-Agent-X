using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace LocalAgentX.Installer.Services;

// Spawns `node scripts/install-common.mjs --ipc` and parses its JSONL stream
// into typed ProgressEvent callbacks. The Avalonia UI binds to those events
// to drive its step list and log view.
public class InstallProcess
{
    public event Action<ProgressEvent>? OnEvent;
    public event Action<int>? OnExit;

    private Process? _proc;

    public void Start(string repoRoot, string? installedCommit = null, bool installOllama = false)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Node writes its JSONL + forwarded child output (npm/ollama progress
            // bars use █ ▒ block glyphs) as UTF-8. Without these, .NET decodes the
            // streams with the console's ANSI codepage (CP1252 on Windows), turning
            // every multi-byte char into mojibake (█ → "â–ˆ") in the details view.
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(Path.Combine(repoRoot, "scripts", "install-common.mjs"));
        psi.ArgumentList.Add("--ipc");

        // Standalone installs: SourceDownloader resolved the source ref to an
        // immutable commit sha and downloaded that exact archive. Forward it
        // so install-common.mjs can seed ~/.lax/installed-source.json (the
        // rolling-update baseline) with the commit actually installed.
        // Developer-clone installs pass null — git is their source of truth.
        if (!string.IsNullOrEmpty(installedCommit))
            psi.Environment["LAX_INSTALLED_COMMIT"] = installedCommit;

        // Opt-in from the Welcome checkbox. install-common.mjs reads this
        // (WANT_OLLAMA) to gate BOTH the Ollama runtime install and the ~670 MB
        // embedding-model pull. Unset/"0" → the fast default: no download, memory
        // runs on the built-in local embedder.
        psi.Environment["LAX_INSTALL_OLLAMA"] = installOllama ? "1" : "0";

        _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _proc.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            try
            {
                var evt = JsonSerializer.Deserialize<ProgressEvent>(e.Data);
                if (evt != null && !string.IsNullOrEmpty(evt.Type))
                {
                    OnEvent?.Invoke(evt);
                    return;
                }
            }
            catch
            {
                // Non-JSON line on stdout — surface as a raw log line so the
                // UI's details view still shows what the process emitted.
            }
            OnEvent?.Invoke(new ProgressEvent { Type = "log", Level = "info", Line = e.Data });
        };
        _proc.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            OnEvent?.Invoke(new ProgressEvent { Type = "log", Level = "warn", Line = e.Data });
        };
        _proc.Exited += (_, _) => OnExit?.Invoke(_proc?.ExitCode ?? -1);

        _proc.Start();
        _proc.BeginOutputReadLine();
        _proc.BeginErrorReadLine();
    }

    public void Cancel()
    {
        try { _proc?.Kill(entireProcessTree: true); } catch { /* already exited */ }
    }
}
