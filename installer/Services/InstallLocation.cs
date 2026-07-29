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

    // Where the installer writes its own run logs. INVARIANT: this must live
    // OUTSIDE GetSourceDir() — the install flow recursively deletes the source
    // dir to replace a prior install, and the installer holds its current log
    // open with an active StreamWriter. A log inside the source tree makes the
    // installer deadlock on its own file handle and every install fails with
    // "a file is locked" naming its own install-<timestamp>.log.
    public static string GetInstallerLogDir()
    {
        if (OperatingSystem.IsWindows())
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Local Agent X Installer", "logs");

        if (OperatingSystem.IsMacOS())
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library", "Logs", "Local Agent X Installer");

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".local", "share", "local-agent-x-installer", "logs");
    }
}
