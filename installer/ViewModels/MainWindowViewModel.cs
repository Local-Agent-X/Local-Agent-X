using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using LocalAgentX.Installer.Services;

namespace LocalAgentX.Installer.ViewModels;

public partial class MainWindowViewModel : ObservableObject
{
    private readonly InstallProcess _process = new();
    private readonly NodeBootstrap _node = new();
    private readonly SourceDownloader _source = new();
    private string _repoRoot = "";
    // The run in flight before install-common.mjs starts; null once it has
    // handed over to _process (whose own Cancel kills that tree).
    private CancellationTokenSource? _runCts;

    public ObservableCollection<StepViewModel> Steps { get; } = new();

    // welcome | progress | done | error
    [ObservableProperty] private string _screen = "welcome";
    [ObservableProperty] private string _currentStepLabel = "";
    [ObservableProperty] private string _currentStepDetail = "";
    [ObservableProperty] private bool _showLog = false;
    [ObservableProperty] private string _logText = "";
    [ObservableProperty] private int _logLineCount;
    [ObservableProperty] private bool _hasLogFile;
    [ObservableProperty] private string _errorMessage = "";

    // Live progress bar. While a step runs we show an indeterminate (pulsing)
    // bar — most steps (npm install, tsc, electron-builder) have no clean
    // percentage. When install-common.mjs streams a {type:"progress"} event
    // (ollama's model pull does), we flip to determinate and track the value.
    [ObservableProperty] private double _progressValue;
    [ObservableProperty] private bool _progressIndeterminate = true;

    // Independent opt-ins: the runtime can be installed without acquiring any
    // model, and the memory model can be requested for an existing runtime.
    [ObservableProperty] private bool _installOllama = false;
    [ObservableProperty] private bool _installOllamaMemoryModel = false;

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
        _node.OnLogLine += line => Dispatcher.UIThread.Post(() => AppendLog($"[node-bootstrap] {line}"));
        _source.OnStatus += s => Dispatcher.UIThread.Post(() => { CurrentStepDetail = s; });
        _source.OnProgress += (got, total) => Dispatcher.UIThread.Post(() =>
        {
            var mb = got / (1024.0 * 1024.0);
            // codeload streams chunked with no Content-Length, so a running
            // byte count is the only progress there is to show.
            CurrentStepDetail = total is long t && t > 0
                ? $"Downloading: {mb:F1} / {t / (1024.0 * 1024.0):F1} MB"
                : $"Downloading: {mb:F1} MB";
        });
        _ = RefreshHardwareEvidenceAsync();
    }

    // Not concurrent: after Cancel the welcome screen's Install button stays
    // disabled until the cancelled run has unwound, so a new run never overlaps
    // the old one's download or Node bootstrap in the same install directory.
    [RelayCommand(AllowConcurrentExecutions = false)]
    private async Task Install()
    {
        using var run = new CancellationTokenSource();
        _runCts = run;
        try
        {
            await RunInstallAsync(run.Token);
        }
        catch (Exception) when (run.IsCancellationRequested)
        {
            // Cancel already put the welcome screen back; whatever the
            // abandoned step threw while unwinding isn't the user's problem.
        }
        finally
        {
            _runCts = null;
        }
    }

    // Cancel runs on this UI thread too, so it can only land while a step is
    // being awaited: checking the token after every await is what guarantees a
    // cancelled run never reaches _process.Start.
    private async Task RunInstallAsync(CancellationToken ct)
    {
        Screen = "progress";
        Steps.Clear();
        _log.Clear();
        LogText = "";
        LogLineCount = 0;
        OpenLogFile();

        // Environment.ProcessPath returns the actual on-disk .exe location
        // even when run as a single-file PublishSingleFile binary (where
        // AppContext.BaseDirectory points at the bundle extraction temp
        // dir, not the .exe's actual folder).
        var exePath = Environment.ProcessPath ?? AppContext.BaseDirectory;
        var exeDir  = Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory;
        var clonedRepoRoot = ResolveRepoRoot(exeDir);
        bool inClonedRepo  = File.Exists(Path.Combine(clonedRepoRoot, "scripts", "install-common.mjs"));

        // Two install flows share the rest of this method:
        //   1. Developer clone — .exe is inside a cloned repo. Use it.
        //   2. End-user download — .exe was downloaded standalone. Fetch
        //      the source tarball from GitHub for the tag this installer
        //      was built to install, extract into the standard per-user
        //      app-data dir, and run from there.
        if (inClonedRepo)
        {
            _repoRoot = clonedRepoRoot;
        }
        else
        {
            CurrentStepLabel = "Source download";
            CurrentStepDetail = $"Fetching {_source.Tag} from GitHub";
            var srcStep = new StepViewModel { Id = "_bootstrap_source", Label = "Source download", State = "running", Detail = CurrentStepDetail };
            Steps.Add(srcStep);
            try
            {
                _repoRoot = await Task.Run(() => _source.DownloadAndExtractAsync(InstallLocation.GetSourceDir(), ct), ct);
                ct.ThrowIfCancellationRequested();
                srcStep.State = "done";
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                Screen = "error";
                ErrorMessage = $"Couldn't download Local Agent X source.\n\n{ex.Message}\n\nCheck your internet connection and try again.";
                return;
            }
        }

        // POSIX shell (Git Bash) is provisioned by install-common.mjs itself
        // (its win32 posix-shell step downloads PortableGit when none is present),
        // so there's no pre-step here — bash isn't needed to RUN that script.

        // Node bootstrap runs BEFORE the IPC stream because install-common.mjs
        // can't execute without Node. Show a synthetic step in the UI so the
        // user sees something happening — the IPC plan event will replace
        // the step list once install-common.mjs starts.
        if (!_node.NodeAvailable())
        {
            CurrentStepLabel = "Node.js runtime";
            CurrentStepDetail = "Provisioning the portable runtime (one-time)…";
            Steps.Add(new StepViewModel { Id = "_bootstrap_node", Label = "Node.js runtime", State = "running", Detail = "Downloading Node.js…" });
            bool ok = await Task.Run(() => _node.InstallNode(ct), ct);
            ct.ThrowIfCancellationRequested();
            if (!ok)
            {
                Screen = "error";
                ErrorMessage = "Couldn't install Node.js. Install it manually from nodejs.org and re-run.";
                return;
            }
            var step = Steps.FirstOrDefault(s => s.Id == "_bootstrap_node");
            if (step != null) step.State = "done";
        }

        _process.Start(_repoRoot, _source.ResolvedCommit, InstallOllama, InstallOllamaMemoryModel);
    }

    [RelayCommand]
    private void Cancel()
    {
        // CancelAsync flips the token at once but runs its callbacks on the
        // thread pool, so a step that unwinds inline on cancellation (temp-dir
        // cleanup in a finally) doesn't freeze this UI thread.
        _ = _runCts?.CancelAsync();
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
                var programs = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs");
                var app = new[]
                {
                    Path.Combine(programs, "local-agent-x-desktop", "LocalAgentX.exe"),
                    Path.Combine(programs, "Local Agent X", "LocalAgentX.exe"),
                }
                    .Where(File.Exists)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();
                if (app is null)
                {
                    Screen = "error";
                    ErrorMessage = "The packaged Local Agent X app is missing. Check Windows Security → Protection history, then re-run the installer.";
                    return;
                }
                Process.Start(new ProcessStartInfo
                {
                    FileName = app,
                    WorkingDirectory = Path.GetDirectoryName(app),
                    UseShellExecute = true,
                });
            }
            else if (OperatingSystem.IsMacOS())
            {
                // The install copies the built .app to /Applications. `open`
                // launches it the same way Launchpad / Spotlight does.
                var dst = new[]
                {
                    "/Applications/Local Agent X.app",
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        "Applications", "Local Agent X.app"),
                }
                    .Where(Directory.Exists)
                    .OrderByDescending(Directory.GetLastWriteTimeUtc)
                    .FirstOrDefault();
                if (dst is null)
                {
                    Screen = "error";
                    ErrorMessage = "The packaged Local Agent X app is missing. Re-run the installer.";
                    return;
                }
                Process.Start(new ProcessStartInfo { FileName = "open", ArgumentList = { dst }, UseShellExecute = false });
            }
        }
        catch (Exception ex)
        {
            AppendLog($"[error] Launch failed: {ex.Message}");
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
                        // New step: pulse indeterminately until/unless it
                        // streams a real percentage.
                        ProgressIndeterminate = true;
                        ProgressValue = 0;
                    }
                    if (evt.State == "error")
                    {
                        step.ErrorMessage = evt.Message;
                    }
                    break;
                }

            case "progress":
                if (evt.Percent is int pct)
                {
                    ProgressIndeterminate = false;
                    ProgressValue = Math.Clamp(pct, 0, 100);
                }
                break;

            case "log":
                AppendLog($"[{evt.Level ?? "info"}] {evt.Line}");
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
