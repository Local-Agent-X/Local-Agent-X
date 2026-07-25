using System;
using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using LocalAgentX.Installer.ViewModels;

namespace LocalAgentX.Installer.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void InitializeComponent() => AvaloniaXamlLoader.Load(this);

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (DataContext is MainWindowViewModel vm)
            vm.PropertyChanged += OnViewModelPropertyChanged;
    }

    // Follow the tail: whenever a new line lands, scroll the log to the bottom
    // so the newest output is always visible. The old fixed-height panel just
    // let new lines scroll off-screen with no way to catch up.
    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(MainWindowViewModel.LogText)) return;
        var scroller = this.FindControl<ScrollViewer>("LogScroller");
        if (scroller != null)
            Dispatcher.UIThread.Post(scroller.ScrollToEnd, DispatcherPriority.Background);
    }
}
