using System.Formats.Tar;
using System.IO.Compression;
using System.Reflection;

namespace LocalAgentX.Installer.Services;

// Downloads the LAX source tarball from GitHub and extracts it to the
// install location. Runs BEFORE Node bootstrap + install-common.mjs in
// the standalone install flow (user downloaded the .exe from the website
// to Downloads/ and double-clicked; no cloned repo present). The
// developer-clone flow (.exe sitting inside a cloned repo) skips this
// entirely.
//
// The ref to download is baked in at build time via MSBuild properties
// InstallerSourceTag (the ref name) + InstallerSourceRefKind ("heads" | "tags"),
// surfaced at runtime as [AssemblyMetadata]. Two modes:
//   - Branch tracking (default; e.g. ref "main", kind "heads"): every run
//     fetches the latest pushed commit of that branch, so ONE uploaded
//     installer keeps serving current code with no rebuild per app update.
//   - Tag pinning (release builds; ref "vX.Y.Z", kind "tags"): re-running an
//     old installer always reproduces that exact snapshot.
public class SourceDownloader
{
    private const string REPO_OWNER = "Local-Agent-X";
    private const string REPO_NAME = "Local-Agent-X";

    public event Action<string>? OnStatus;
    public event Action<long, long?>? OnProgress;

    public string Tag { get; } = ReadMeta("SourceTag", "main");
    public string RefKind { get; } = ReadMeta("SourceRefKind", "heads");

    public async Task<string> DownloadAndExtractAsync(string installDir, CancellationToken ct = default)
    {
        var url = $"https://github.com/{REPO_OWNER}/{REPO_NAME}/archive/refs/{RefKind}/{Tag}.tar.gz";
        OnStatus?.Invoke($"Downloading source ({Tag})…");

        var tmpTgz = Path.Combine(Path.GetTempPath(), $"lax-source-{Guid.NewGuid():N}.tar.gz");
        var tmpExtract = Path.Combine(Path.GetTempPath(), $"lax-extract-{Guid.NewGuid():N}");

        try
        {
            await DownloadFileAsync(url, tmpTgz, ct);

            OnStatus?.Invoke("Extracting…");
            Directory.CreateDirectory(tmpExtract);
            await ExtractTarGzAsync(tmpTgz, tmpExtract, ct);

            // GitHub's archive tarball expands as Local-Agent-X-<sha-or-tag>/.
            // Pull the single top-level dir out and move it into installDir.
            var rootDirs = Directory.GetDirectories(tmpExtract);
            if (rootDirs.Length != 1)
                throw new InvalidDataException($"Unexpected tarball layout: {rootDirs.Length} top-level dirs (expected 1)");

            // Replace any prior install. User data lives in ~/.lax/ and is
            // never touched.
            if (Directory.Exists(installDir))
            {
                OnStatus?.Invoke("Removing previous install…");
                Directory.Delete(installDir, recursive: true);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(installDir)!);
            Directory.Move(rootDirs[0], installDir);

            return installDir;
        }
        finally
        {
            try { File.Delete(tmpTgz); } catch { }
            try { if (Directory.Exists(tmpExtract)) Directory.Delete(tmpExtract, recursive: true); } catch { }
        }
    }

    private async Task DownloadFileAsync(string url, string destPath, CancellationToken ct)
    {
        using var http = new HttpClient();
        // GitHub returns 403 to requests without a User-Agent.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");

        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength;

        await using var inStream = await resp.Content.ReadAsStreamAsync(ct);
        await using var outStream = File.Create(destPath);

        var buf = new byte[81920];
        long downloaded = 0;
        int read;
        while ((read = await inStream.ReadAsync(buf, ct)) > 0)
        {
            await outStream.WriteAsync(buf.AsMemory(0, read), ct);
            downloaded += read;
            OnProgress?.Invoke(downloaded, total);
        }
    }

    private async Task ExtractTarGzAsync(string tgzPath, string destDir, CancellationToken ct)
    {
        await using var fs = File.OpenRead(tgzPath);
        await using var gz = new GZipStream(fs, CompressionMode.Decompress);
        await TarFile.ExtractToDirectoryAsync(gz, destDir, overwriteFiles: true, cancellationToken: ct);
    }

    private static string ReadMeta(string key, string fallback)
    {
        var asm = Assembly.GetExecutingAssembly();
        var val = asm.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(m => m.Key == key)?.Value;
        // Local dev builds leave these unset, so they default to tracking the
        // "main" branch (kind "heads"). CI sets SourceTag (+ SourceRefKind
        // "tags" for vX.Y.Z) on release builds for a pinned snapshot.
        return string.IsNullOrWhiteSpace(val) ? fallback : val!;
    }
}
