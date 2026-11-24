using System.Diagnostics;
using System.Net;

namespace LocalAgentX.Installer.Services;

// Downloads a file the way a slow or flaky link needs: no limit on the whole
// body, only on silence. A server may stream chunked with no Content-Length
// (GitHub's codeload does), so a connection that goes quiet mid-body would
// block a read forever; silence for READ_IDLE_TIMEOUT abandons the attempt. A
// partial chunked body can't be resumed, so each retry starts from byte zero.
//
// Used for the source archive (SourceDownloader) and the portable Node runtime
// (NodeBootstrap), which used HttpClient's default 100 s whole-body timeout and
// so failed on any link too slow to finish in that time.
public static class StallAwareDownload
{
    private const int DOWNLOAD_ATTEMPTS = 3;
    private static readonly TimeSpan READ_IDLE_TIMEOUT = TimeSpan.FromSeconds(30);
    // HttpClient.Timeout stops covering the request once ResponseHeadersRead
    // hands back the body stream, so this bounds only the wait for headers
    // (including any redirect).
    private static readonly TimeSpan HEADERS_TIMEOUT = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RETRY_BACKOFF = TimeSpan.FromSeconds(2);
    // Every progress event becomes a UI-thread post; one per 80 KB read would
    // flood the dispatcher on a fast link.
    private const int PROGRESS_INTERVAL_MS = 250;

    // `source` names the server in messages ("GitHub"); `hosts` is what the
    // user should make reachable ("github.com and codeload.github.com").
    // Every handler is filtered on ct: a user cancel is never retried and never
    // reported as a stall.
    public static async Task DownloadAsync(
        string url, string destPath, string source, string hosts,
        Action<string>? onStatus, Action<long, long?>? onProgress, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = HEADERS_TIMEOUT };
        // GitHub returns 403 to requests without a User-Agent.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");

        for (int attempt = 1; ; attempt++)
        {
            try
            {
                await DownloadAttemptAsync(http, url, destPath, onProgress, ct);
                return;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && NetworkFault(ex, source) is string fault)
            {
                if (attempt == DOWNLOAD_ATTEMPTS)
                    throw new IOException(
                        $"The download from {source} stalled or failed {DOWNLOAD_ATTEMPTS} times (last: {fault}). " +
                        $"If this PC is behind a VPN, proxy, or firewall, make sure it can reach {hosts}, then run the installer again.",
                        ex);
                var kind = ex is TimeoutException or OperationCanceledException ? "stalled" : "failed";
                onStatus?.Invoke($"Download {kind}, retrying ({attempt + 1}/{DOWNLOAD_ATTEMPTS})…");
                await Task.Delay(RETRY_BACKOFF * attempt, ct);
            }
        }
    }

    // File.Create truncates, so every attempt writes a fresh file from byte zero.
    private static async Task DownloadAttemptAsync(
        HttpClient http, string url, string destPath, Action<long, long?>? onProgress, CancellationToken ct)
    {
        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength;

        await using var inStream = await resp.Content.ReadAsStreamAsync(ct);
        await using var outStream = File.Create(destPath);
        // Linked so the user's cancel still aborts a pending read at once; the
        // timer is re-armed before every read, so only a full idle window of
        // silence trips it.
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var buf = new byte[81920];
        long downloaded = 0;
        var sinceProgress = Stopwatch.StartNew();
        while (true)
        {
            idle.CancelAfter(READ_IDLE_TIMEOUT);
            int read;
            try
            {
                read = await inStream.ReadAsync(buf, idle.Token);
            }
            catch (Exception) when (idle.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new TimeoutException($"no data received for {READ_IDLE_TIMEOUT.TotalSeconds:F0} s");
            }
            catch (IOException ex) when (!ct.IsCancellationRequested)
            {
                throw new BodyReadException(ex);
            }
            if (read == 0) return;
            await outStream.WriteAsync(buf.AsMemory(0, read), ct);
            downloaded += read;
            if (sinceProgress.ElapsedMilliseconds >= PROGRESS_INTERVAL_MS)
            {
                onProgress?.Invoke(downloaded, total);
                sinceProgress.Restart();
            }
        }
    }

    // The reason an attempt failed, worded for the final error, or null when the
    // failure isn't a network fault another attempt could fix. An
    // OperationCanceledException that isn't the user's cancel is HttpClient.Timeout.
    // A local write error (disk full, a locked temp file) and a definite HTTP
    // refusal such as 404 fail on the first attempt with their own message.
    private static string? NetworkFault(Exception ex, string source) => ex switch
    {
        TimeoutException => ex.Message,
        OperationCanceledException => $"{source} didn't respond within {HEADERS_TIMEOUT.TotalSeconds:F0} s",
        BodyReadException => ex.Message,
        HttpRequestException { StatusCode: null } => ex.Message,
        HttpRequestException { StatusCode: HttpStatusCode.TooManyRequests } => ex.Message,
        HttpRequestException { StatusCode: { } status } when (int)status >= 500 => ex.Message,
        _ => null,
    };

    // The response body failed mid-read: a network fault, unlike an IOException
    // from writing the temp file.
    private sealed class BodyReadException : IOException
    {
        public BodyReadException(IOException inner) : base($"the connection dropped ({inner.Message})", inner) { }
    }
}
