using System.Diagnostics;
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

    public void Start(string repoRoot)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(Path.Combine(repoRoot, "scripts", "install-common.mjs"));
        psi.ArgumentList.Add("--ipc");

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
