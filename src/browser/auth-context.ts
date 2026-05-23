// Auth token passed via setter instead of process.env to avoid leaking to
// child processes.
let _saxAuthToken = "";
let _saxPort = "";

export function setBrowserAuthContext(token: string, port: string): void {
  _saxAuthToken = token;
  _saxPort = port;
}

export function injectTokenIfLocal(url: string): string {
  try {
    const u = new URL(url);
    const appPort = _saxPort || process.env.LAX_PORT || process.env.SAX_PORT || "7007";
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === appPort) {
      if (_saxAuthToken && !u.searchParams.has("token")) {
        u.searchParams.set("token", _saxAuthToken);
        return u.toString();
      }
    }
  } catch { /* invalid URL — caller handles */ }
  return url;
}
