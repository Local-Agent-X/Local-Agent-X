// Installer downloads. A connection that fails outright ("fetch failed") is
// retried a few times: a fresh machine's first minutes are when antivirus,
// VPN and firewall changes land, and a dropped connection is often transient.
// Whatever finally fails is reported with its underlying cause (DNS, reset,
// timeout, certificate) and host, which the bare "fetch failed" hides; a
// friend's install once died on that message alone. An HTTP error status is
// an answer, not a dropped connection, so it is returned for the caller.

export function describeNetworkError(error) {
  const cause = error && error.cause;
  if (!cause) return (error && error.message) || String(error);
  const code = cause.code || cause.name || "";
  const host = cause.hostname || cause.host || "";
  const label = [code, host].filter(Boolean).join(" ");
  return `${error.message} (${label}${cause.message ? `${label ? ": " : ""}${cause.message}` : ""})`;
}

export async function fetchWithRetry(url, { fetchImpl = globalThis.fetch, init, attempts = 3, retryDelayMs = 2000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error(`could not reach ${new URL(url).host} after ${attempts} tries: ${describeNetworkError(last)}`);
}
