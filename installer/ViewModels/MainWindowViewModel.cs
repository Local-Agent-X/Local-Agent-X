using System.Collections.ObjectModel;
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
    private readonly StringBuilder _log = new();

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
    }

    [RelayCommand]
    private void Install()
    {
        Screen = "progress";
        Steps.Clear();
        _log.Clear();
        LogText = "";

        var exeDir = AppContext.BaseDirectory;
        var repoRoot = ResolveRepoRoot(exeDir);
        _process.Start(repoRoot);
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
        // Phase 2: invoke the installed app (shortcut on Windows, .app on macOS).
        // For now: signal completion via process exit so the installer window closes.
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
