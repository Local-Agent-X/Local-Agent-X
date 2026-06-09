// Right-time recovery for a LEGITIMATE local-service health-check that hits the
// loopback/private-IP block. Ties the model to the localServicePorts allowlist
// added for operator-trusted bridges/dev servers. NOT used for SSRF-attack
// shapes (cloud metadata, hex/decimal-encoded IPs) — those should never be
// allowlisted.
export const LOCAL_SERVICE_RECOVERY =
  'If this is your own local service (a dev server / bridge you started), add its port to ' +
  '"localServicePorts" in ~/.lax/security.json to allow loopback health-checks. ' +
  "Otherwise verify the service via process_status/process_list or the filesystem instead of HTTP.";

// ── SSRF: IP address validation helpers ──

/** Strictly parse a decimal IPv4 address — rejects octal (0177) and hex (0x7f) formats */
function parseStrictIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    // Reject octal (leading zeros) and hex (0x prefix) — only strict decimal
    if (!/^\d+$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const n = Number(part);
    if (isNaN(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** Check if an IPv4 address is private/loopback/link-local/reserved */
export function isPrivateIPv4(ip: string): boolean {
  const parts = parseStrictIPv4(ip);
  if (!parts) return true; // malformed or non-decimal → block (fail-closed)

  const [a, b] = parts;
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8 private
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a >= 224) return true;                           // multicast + reserved (224+)
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  return false;
}

/** Normalize an IPv6 address to its canonical compressed form */
function normalizeIPv6(ip: string): string {
  let cleaned = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // A trailing dotted-quad (e.g. 64:ff9b::169.254.169.254 or ::ffff:1.2.3.4)
  // occupies the LAST 32 bits = two hex groups. Rewrite it to those two groups
  // up front so the group math below is correct and the embedded IPv4 survives
  // expansion (parseInt would otherwise truncate "169.254.169.254" to 0x169).
  const dotted = cleaned.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseStrictIPv4(dotted[1]);
    if (v4) {
      const hi = ((v4[0] << 8) | v4[1]).toString(16);
      const lo = ((v4[2] << 8) | v4[3]).toString(16);
      cleaned = cleaned.slice(0, dotted.index) + `${hi}:${lo}`;
    }
  }
  // Expand :: notation to full form, then re-compress
  let groups: string[];
  if (cleaned.includes("::")) {
    const [left, right] = cleaned.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = cleaned.split(":");
  }
  // Normalize each group (strip leading zeros)
  groups = groups.map(g => (parseInt(g, 16) || 0).toString(16));
  // Re-compress: find longest run of zeros
  const full = groups.join(":");
  return full;
}

/** Check if an IPv6 address is private/loopback/link-local */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = normalizeIPv6(ip);

  // Loopback (::1 and all equivalent forms like 0:0:0:0:0:0:0:1)
  if (normalized === "0:0:0:0:0:0:0:1" || normalized === "::1") return true;
  // Unspecified (:: and 0:0:0:0:0:0:0:0)
  if (normalized === "0:0:0:0:0:0:0:0" || normalized === "::") return true;
  // Link-local
  if (normalized.startsWith("fe80:") || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // Unique local (fc00::/7)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check original form for dotted notation
  const original = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const v4mapped = original.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);

  // IPv4-mapped IPv6 hex form (::ffff:7f00:1 = 127.0.0.1)
  const v4mappedHex = normalized.match(/^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(reconstructed);
  }

  // IPv4-compatible IPv6 (::a.b.c.d)
  const v4compat = original.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIPv4(v4compat[1]);

  // ── Embedded-IPv4 transition prefixes (NAT64 / 6to4) ──
  // These standard mechanisms wrap an IPv4 address inside an IPv6 literal, so a
  // literal like 64:ff9b::169.254.169.254 or 2002:a9fe:a9fe:: reaches the
  // embedded IPv4 (here, cloud metadata) while looking like a benign IPv6 host.
  // Decode the embedded v4 from the normalized 8-group form and range-check it
  // with isPrivateIPv4; only a private/reserved/metadata embedding is blocked,
  // so a transition literal wrapping a PUBLIC IPv4 (e.g. 2002:0808:0808:: =
  // 8.8.8.8) is still allowed.
  const groups = normalized.split(":");
  if (groups.length === 8) {
    const g = groups.map(h => parseInt(h, 16) & 0xffff);
    const v4From = (hi: number, lo: number) =>
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

    // NAT64 well-known prefix 64:ff9b::/96 (RFC6052): the embedded IPv4 is the
    // last 32 bits (groups 6-7). Also covers the local-use prefix 64:ff9b:1::/48
    // (RFC8215), whose low 32 bits likewise hold the embedded v4.
    if ((g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) ||
        (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x0001)) {
      if (isPrivateIPv4(v4From(g[6], g[7]))) return true;
    }

    // 6to4 prefix 2002::/16 (RFC3056): the embedded IPv4 is bits 16-48
    // (groups 1-2), e.g. 2002:a9fe:a9fe:: = 169.254.169.254.
    if (g[0] === 0x2002) {
      if (isPrivateIPv4(v4From(g[1], g[2]))) return true;
    }
  }

  return false;
}

/** Blocked hostnames (loopback aliases, cloud metadata) */
export const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.internal",
  "metadata",
  "instance-data",                        // AWS EC2 metadata alias
  "kubernetes.default.svc",               // K8s in-cluster API
  "kubernetes.default",                    // K8s in-cluster API
]);
