using System.Formats.Tar;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

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

    // The immutable commit sha the installed bytes are bound to. Set during
    // DownloadAndExtractAsync, before any bytes are fetched; the install flow
    // forwards it to install-common.mjs so the rolling-update baseline marker
    // records the commit that was actually installed.
    public string? ResolvedCommit { get; private set; }

    public async Task<string> DownloadAndExtractAsync(string installDir, CancellationToken ct = default)
    {
        // Resolve the configured ref to an immutable commit sha FIRST, then
        // download the per-commit archive. Both refs/heads/* AND refs/tags/*
        // are mutable (a branch advances, a tag can be force-moved), so the
        // bytes behind archive/refs/... can change between any two requests;
        // archive/<sha>.tar.gz cannot. Pinning the download URL to the
        // resolved sha binds the installed bytes to a named commit — the same
        // integrity invariant as the in-app rolling update
        // (src/ota-update.ts downloadMainTarball / applyUpdate).
        OnStatus?.Invoke($"Resolving {Tag}…");
        var commit = await ResolveCommitAsync(ct);
        ResolvedCommit = commit;

        var url = $"https://github.com/{REPO_OWNER}/{REPO_NAME}/archive/{commit}.tar.gz";
        OnStatus?.Invoke($"Downloading source ({Tag} @ {commit[..7]})…");

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

    // Resolve the baked-in ref to the commit sha it currently points at, via
    // git/ref/{heads|tags}/{name} — the endpoint that honors RefKind exactly
    // (commits/{ref} rejects tags/<name> qualified refs with 422). Release
    // tags here are annotated, so the ref points at a tag OBJECT; dereference
    // it through git/tags/{sha} to the commit. Refuses with a clear error
    // rather than falling back to the mutable-ref archive: an unpinned
    // download has no integrity binding (mirrors downloadMainTarball's
    // reject-on-unresolved posture).
    private async Task<string> ResolveCommitAsync(CancellationToken ct)
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");

        var api = $"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}";
        var (sha, type) = await GetRefObjectAsync(http, $"{api}/git/ref/{RefKind}/{Tag}", ct);
        if (type == "tag")
            (sha, type) = await GetRefObjectAsync(http, $"{api}/git/tags/{sha}", ct);

        if (type != "commit" || !Regex.IsMatch(sha, "^[0-9a-f]{40}$"))
            throw new InvalidDataException(
                $"Couldn't resolve '{RefKind}/{Tag}' to a commit (got {type} '{sha}'). Refusing an unpinned source download.");
        return sha;
    }

    // Both git/ref/* and git/tags/* responses carry the target as
    // object.{sha,type} — one extractor covers ref lookup and tag deref.
    private static async Task<(string sha, string type)> GetRefObjectAsync(HttpClient http, string url, CancellationToken ct)
    {
        using var resp = await http.GetAsync(url, ct);
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
        if (!doc.RootElement.TryGetProperty("object", out var obj))
            throw new InvalidDataException($"Unexpected response shape from {url} (no 'object').");
        return (obj.GetProperty("sha").GetString() ?? "", obj.GetProperty("type").GetString() ?? "");
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
