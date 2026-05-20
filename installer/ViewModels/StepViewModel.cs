using CommunityToolkit.Mvvm.ComponentModel;

namespace LocalAgentX.Installer.ViewModels;

public partial class StepViewModel : ObservableObject
{
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";

    // pending | running | done | error
    [ObservableProperty] private string _state = "pending";
    [ObservableProperty] private string? _detail;
    [ObservableProperty] private string? _errorMessage;

    public string Icon => State switch
    {
        "pending" => "○",
        "running" => "↻",
        "done"    => "✓",
        "error"   => "✕",
        _ => "○",
    };

    partial void OnStateChanged(string value) => OnPropertyChanged(nameof(Icon));
}
