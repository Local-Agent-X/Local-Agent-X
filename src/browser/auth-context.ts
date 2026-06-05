// Auth token passed via setter instead of process.env to avoid leaking to
// child processes.
let _laxAuthToken = "";
let _laxPort = "";

export function setBrowserAuthContext(token: string, port: string): void {
  _laxAuthToken = token;
  _laxPort = port;
}

export function injectTokenIfLocal(url: string): string {
  try {
    const u = new URL(url);
    const appPort = _laxPort || process.env.LAX_PORT || "7007";
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === appPort) {
      if (_laxAuthToken && !u.searchParams.has("token")) {
        u.searchParams.set("token", _laxAuthToken);
        return u.toString();
      }
    }
  } catch { /* invalid URL — caller handles */ }
  return url;
}
