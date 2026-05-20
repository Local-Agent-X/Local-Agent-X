using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using System.Text;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using LocalAgentX.Installer.Services;

namespace LocalAgentX.Installer.ViewModels;

public partial class MainWindowViewModel : ObservableObject
{
    private readonly InstallProcess _process = new();
    private readonly NodeBootstrap _node = new();
    private readonly StringBuilder _log = new();
    private string _repoRoot = "";

    public ObservableCollection<StepViewModel> Steps { get; } = new();

    // welcome | progress | done | error
    [ObservableProperty] private string _screen = "welcome";
    [ObservableProperty] private string _currentStepLabel = "";
    [ObservableProperty] private string _currentStepDetail = "";
    [ObservableProperty] private bool _showLog = false;
    [ObservableProperty] private string _logText = "";
    [ObservableProperty] private string _errorMessage = "";

    // Computed flags for XAML IsVisible bindings — CommunityToolkit's
    // [ObservableProperty] doesn't auto-fire dependent props, so we notify
    // them manually in OnScreenChanged.
    public bool IsWelcome  => Screen == "welcome";
    public bool IsProgress => Screen == "progress";
    public bool IsDone     => Screen == "done";
    public bool IsError    => Screen == "error";

    partial void OnScreenChanged(string value)
    {
        OnPropertyChanged(nameof(IsWelcome));
        OnPropertyChanged(nameof(IsProgress));
        OnPropertyChanged(nameof(IsDone));
        OnPropertyChanged(nameof(IsError));
    }

    public MainWindowViewModel()
    {
        _process.OnEvent += HandleEvent;
        _process.OnExit += HandleExit;
        _node.OnStatus  += s => Dispatcher.UIThread.Post(() => { CurrentStepLabel = s; });
        _node.OnLogLine += line => Dispatcher.UIThread.Post(() =>
        {
            _log.AppendLine($"[node-bootstrap] {line}");
            LogText = _log.ToString();
        });
    }

    [RelayCommand]
    private async Task Install()
    {
        Screen = "progress";
        Steps.Clear();
        _log.Clear();
        LogText = "";

        // Environment.ProcessPath returns the actual on-disk .exe location
        // even when run as a single-file PublishSingleFile binary (where
        // AppContext.BaseDirectory points at the bundle extraction temp
        // dir, not the .exe's actual folder).
        var exePath = Environment.ProcessPath ?? AppContext.BaseDirectory;
        var exeDir  = Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory;
        _repoRoot   = ResolveRepoRoot(exeDir);

        // Node bootstrap runs BEFORE the IPC stream because install-common.mjs
        // can't execute without Node. Show a synthetic step in the UI for
        // this so the user sees something happening — the IPC plan event
        // will replace the step list once install-common.mjs starts.
        if (!_node.NodeAvailable())
        {
            CurrentStepLabel = "Node.js runtime";
            CurrentStepDetail = "Installing via winget (one-time)…";
            Steps.Add(new StepViewModel { Id = "_bootstrap_node", Label = "Node.js runtime", State = "running", Detail = "Installing via winget…" });
            bool ok = await Task.Run(() => _node.InstallNode());
            if (!ok)
            {
                Screen = "error";
                ErrorMessage = "Couldn't install Node.js. Install it manually from nodejs.org and re-run.";
                return;
            }
            var step = Steps.FirstOrDefault(s => s.Id == "_bootstrap_node");
            if (step != null) step.State = "done";
        }

        _process.Start(_repoRoot);
    }

    [RelayCommand]
    private void Cancel()
    {
        _process.Cancel();
        Screen = "welcome";
    }

    [RelayCommand]
    private void Launch()
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                // Launch electron.exe directly with the desktop main.js — same
                // shape install-common.mjs writes into the shortcut .lnk, but
                // without depending on the shortcut existing yet (it's created
                // late in the install). WorkingDirectory matches the .lnk so
                // relative paths inside the Electron main process resolve.
                var electron = Path.Combine(_repoRoot, "desktop", "node_modules", "electron", "dist", "electron.exe");
                var mainJs   = Path.Combine(_repoRoot, "desktop", "dist", "main.js");
                if (File.Exists(electron) && File.Exists(mainJs))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = electron,
                        WorkingDirectory = Path.Combine(_repoRoot, "desktop"),
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        ArgumentList = { mainJs },
                    });
                }
            }
            else if (OperatingSystem.IsMacOS())
            {
                // The install copies the built .app to /Applications. `open`
                // launches it the same way Launchpad / Spotlight does.
                var dst = "/Applications/Local Agent X.app";
                if (Directory.Exists(dst))
                {
                    Process.Start(new ProcessStartInfo { FileName = "open", ArgumentList = { dst }, UseShellExecute = false });
                }
            }
        }
        catch (Exception ex)
        {
            _log.AppendLine($"[error] Launch failed: {ex.Message}");
            LogText = _log.ToString();
        }
        Environment.Exit(0);
    }

    [RelayCommand]
    private void Close() => Environment.Exit(IsError ? 1 : 0);

    private void HandleEvent(ProgressEvent evt)
    {
        Dispatcher.UIThread.Post(() => ApplyEvent(evt));
    }

    private void ApplyEvent(ProgressEvent evt)
    {
        switch (evt.Type)
        {
            case "plan":
                if (evt.Steps == null) return;
                Steps.Clear();
                foreach (var s in evt.Steps)
                    Steps.Add(new StepViewModel { Id = s.Id, Label = s.Label });
                break;

            case "step":
                {
                    var step = Steps.FirstOrDefault(s => s.Id == evt.Id);
                    if (step == null) return;
                    step.State = evt.State ?? "running";
                    if (evt.Detail != null) step.Detail = evt.Detail;
                    if (evt.State == "running")
                    {
                        CurrentStepLabel = step.Label;
                        CurrentStepDetail = evt.Detail ?? "";
                    }
                    if (evt.State == "error")
                    {
                        step.ErrorMessage = evt.Message;
                    }
                    break;
                }

            case "log":
                _log.AppendLine($"[{evt.Level ?? "info"}] {evt.Line}");
                LogText = _log.ToString();
                break;

            case "complete":
                Screen = "done";
                break;

            case "fatal":
                Screen = "error";
                ErrorMessage = evt.Message ?? "Installation failed.";
                break;
        }
    }

    private void HandleExit(int code)
    {
        Dispatcher.UIThread.Post(() =>
        {
            if (code != 0 && Screen == "progress")
            {
                Screen = "error";
                if (string.IsNullOrEmpty(ErrorMessage))
                    ErrorMessage = $"Installer exited with code {code}. See log for details.";
            }
        });
    }

    // Walk up from the exe's directory looking for scripts/install-common.mjs.
    // Lets us run the installer from `installer/bin/Debug/net8.0/` during dev
    // AND from a packaged location later — same lookup logic.
    private static string ResolveRepoRoot(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "scripts", "install-common.mjs")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return startDir;
    }
}
