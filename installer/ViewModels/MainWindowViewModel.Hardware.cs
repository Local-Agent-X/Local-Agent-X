using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace LocalAgentX.Installer.ViewModels;

public partial class MainWindowViewModel
{
    [ObservableProperty] private string _hardwareSummary = "Inspecting CPU, memory, graphics, and local runtimes...";
    [ObservableProperty] private string _localAiChoices = "No local runtime or model will be selected or downloaded automatically.";
    [ObservableProperty] private bool _hardwareInspectionRunning;
    public bool CanInspectHardware => !HardwareInspectionRunning;

    partial void OnHardwareInspectionRunningChanged(bool value) => OnPropertyChanged(nameof(CanInspectHardware));

    [RelayCommand]
    private async Task RefreshHardwareEvidenceAsync()
    {
        if (HardwareInspectionRunning) return;
        HardwareInspectionRunning = true;
        try
        {
            var evidence = await Task.Run(InspectHardware);
            HardwareSummary = evidence.Summary;
            LocalAiChoices = evidence.Choices;
        }
        finally
        {
            HardwareInspectionRunning = false;
        }
    }

    private static HardwareEvidence InspectHardware()
    {
        var cpu = Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER")?.Trim();
        if (string.IsNullOrWhiteSpace(cpu) && OperatingSystem.IsMacOS()) cpu = Run("sysctl", "-n", "machdep.cpu.brand_string");
        if (string.IsNullOrWhiteSpace(cpu) && OperatingSystem.IsLinux()) cpu = LinuxCpuModel();
        cpu = string.IsNullOrWhiteSpace(cpu) ? $"{Environment.ProcessorCount} logical CPU(s), model unknown" : cpu;

        var memoryBytes = PhysicalMemoryBytes();
        var memory = memoryBytes is > 0 ? $"{memoryBytes.Value / 1073741824d:F1} GiB RAM" : "RAM unknown";
        var graphics = GraphicsEvidence();
        var ollamaVersion = Run("ollama", "--version");
        var runtime = string.IsNullOrWhiteSpace(ollamaVersion) ? "Ollama not detected on PATH" : ollamaVersion;
        string[] modelLines = string.IsNullOrWhiteSpace(ollamaVersion) ? [] : RunLines("ollama", "list").Skip(1).ToArray();
        var models = modelLines.Length == 0
            ? "No installed Ollama models detected."
            : $"Installed Ollama targets: {string.Join(", ", modelLines.Select(line => Regex.Split(line.Trim(), @"\s+")[0]).Where(name => name.Length > 0).Take(6))}.";
        return new HardwareEvidence(
            $"{cpu} | {memory} | {graphics} | {runtime}",
            $"{models} Hardware fit is advisory; verify an exact runtime/model after launch. Verification is bound to the declared runtime identity, runtime version, and model digest. Drift returns it to Not verified. No chat default changes automatically.");
    }

    private static string? LinuxCpuModel()
    {
        try
        {
            return File.ReadLines("/proc/cpuinfo")
                .FirstOrDefault(line => line.StartsWith("model name", StringComparison.OrdinalIgnoreCase))
                ?.Split(':', 2).LastOrDefault()?.Trim();
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static long? PhysicalMemoryBytes()
    {
        if (OperatingSystem.IsWindows())
        {
            var value = Run("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory");
            return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var bytes) ? bytes : null;
        }
        if (OperatingSystem.IsMacOS())
        {
            var value = Run("sysctl", "-n", "hw.memsize");
            return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var bytes) ? bytes : null;
        }
        try
        {
            var line = File.ReadLines("/proc/meminfo").FirstOrDefault(value => value.StartsWith("MemTotal:", StringComparison.OrdinalIgnoreCase));
            var match = Regex.Match(line ?? "", @"(\d+)");
            return match.Success && long.TryParse(match.Value, out var kib) ? kib * 1024 : null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string GraphicsEvidence()
    {
        if (OperatingSystem.IsWindows())
        {
            var names = RunLines("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }");
            return names.Length == 0 ? "graphics unknown" : string.Join(" + ", names.Take(3));
        }
        if (OperatingSystem.IsMacOS())
        {
            var names = RunLines("system_profiler", "SPDisplaysDataType")
                .Where(line => line.TrimStart().StartsWith("Chipset Model:", StringComparison.OrdinalIgnoreCase))
                .Select(line => line.Split(':', 2).Last().Trim()).ToArray();
            return names.Length == 0 ? "graphics/shared memory unknown" : $"{string.Join(" + ", names)} (Apple shared memory)";
        }
        var nvidia = RunLines("nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader");
        if (nvidia.Length > 0) return string.Join(" + ", nvidia.Take(4));
        var pci = RunLines("lspci").Where(line => line.Contains("VGA", StringComparison.OrdinalIgnoreCase) || line.Contains("3D controller", StringComparison.OrdinalIgnoreCase)).ToArray();
        return pci.Length == 0 ? "graphics unknown (probe tools unavailable or no GPU reported)" : string.Join(" + ", pci.Take(3));
    }

    private static string Run(string command, params string[] arguments) => RunLines(command, arguments).FirstOrDefault()?.Trim() ?? "";

    private static string[] RunLines(string command, params string[] arguments)
    {
        try
        {
            var start = new ProcessStartInfo { FileName = command, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start);
            if (process == null) return [];
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(4000))
            {
                process.Kill(true);
                return [];
            }
            return output.GetAwaiter().GetResult().Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return [];
        }
    }

    private sealed record HardwareEvidence(string Summary, string Choices);
}
