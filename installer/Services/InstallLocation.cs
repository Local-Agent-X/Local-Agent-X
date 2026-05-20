namespace LocalAgentX.Installer.Services;

// Where the LAX source repo lives on disk after an end-user install.
// Platform-standard per-user data dirs. User data (~/.lax/) is separate
// and never touched by reinstalls.
public static class InstallLocation
{
    public static string GetSourceDir()
    {
        if (OperatingSystem.IsWindows())
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Local Agent X");

        if (OperatingSystem.IsMacOS())
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library", "Application Support", "Local Agent X");

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".local", "share", "local-agent-x");
    }
}
