using System.Diagnostics;
using System.Text;
using CommunityToolkit.Mvvm.Input;
using LocalAgentX.Installer.Services;

namespace LocalAgentX.Installer.ViewModels;

public partial class MainWindowViewModel
{
    private readonly StringBuilder _log = new();

    // The full install log is mirrored to disk as it streams, so the user can
    // open the complete record even after output scrolls out of the panel.
    private StreamWriter? _logWriter;
    private string _logFilePath = "";

    // Single sink for every log line: mirrors to the visible panel and to the
    // on-disk log. Must be called on the UI thread (it touches observables).
    private void AppendLog(string text)
    {
        _log.AppendLine(text);
        LogText = _log.ToString();
        LogLineCount++;
        // Logging must never break the install — a locked/unwritable file is
        // downgraded to panel-only output rather than surfaced as a failure.
        try { _logWriter?.WriteLine(text); } catch { /* best-effort */ }
    }

    // Open a fresh timestamped log file in a stable, discoverable location
    // (%LOCALAPPDATA%\Local Agent X Installer\logs on Windows). Deliberately
    // OUTSIDE the install target dir — see InstallLocation.GetInstallerLogDir.
    // AutoFlush so the file is complete-to-the-last-line whenever the user
    // opens it.
    private void OpenLogFile()
    {
        try
        {
            var dir = InstallLocation.GetInstallerLogDir();
            Directory.CreateDirectory(dir);
            _logFilePath = Path.Combine(dir, $"install-{DateTime.Now:yyyyMMdd-HHmmss}.log");
            _logWriter?.Dispose();
            _logWriter = new StreamWriter(_logFilePath, append: false) { AutoFlush = true };
            HasLogFile = true;
        }
        catch
        {
            // Non-fatal: the install still runs, just without an on-disk copy.
            _logWriter = null;
            _logFilePath = "";
            HasLogFile = false;
        }
    }

    [RelayCommand]
    private void OpenLog()
    {
        if (string.IsNullOrEmpty(_logFilePath) || !File.Exists(_logFilePath)) return;
        try
        {
            // UseShellExecute lets the OS open the .log with its default handler
            // (Notepad on Windows, Console/TextEdit on macOS).
            Process.Start(new ProcessStartInfo { FileName = _logFilePath, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppendLog($"[error] Couldn't open log file: {ex.Message}");
        }
    }
}
