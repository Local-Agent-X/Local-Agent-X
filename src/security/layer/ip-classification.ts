// Right-time recovery for a LEGITIMATE local-service health-check that hits the
// loopback/private-IP block. Ties the model to the localServicePorts allowlist
// added for operator-trusted bridges/dev servers. NOT used for SSRF-attack
// shapes (cloud metadata, hex/decimal-encoded IPs) — those should never be
// allowlisted.
export const LOCAL_SERVICE_RECOVERY =
  'If this is your own local service (a dev server / bridge you started), add its port to ' +
  '"localServicePorts" in ~/.lax/security.json to allow loopback health-checks. ' +
  "Otherwise verify the service via process_status/process_list or the filesystem instead of HTTP.";

/**
 * Canonicalize a URL host for policy comparison: lowercase, remove IPv6 URL
 * brackets, and strip one trailing DNS dot. WHATWG `new URL()` preserves both
 * bracketed IPv6 hostnames and trailing dots, while policy tables use bare
 * address/hostname forms. Lives here (not in a policy module) because BOTH the
 * sync policy pass and the DNS-pin pass must canonicalize identically.
 */
export function canonicalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

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

interface SpecialUseRange {
  cidr: string;
  reason: string;
}

export const SPECIAL_USE_IPV4_RANGES: readonly SpecialUseRange[] = [
  { cidr: "0.0.0.0/8", reason: "current network" },
  { cidr: "10.0.0.0/8", reason: "private use" },
  { cidr: "100.64.0.0/10", reason: "shared address space" },
  { cidr: "127.0.0.0/8", reason: "loopback" },
  { cidr: "169.254.0.0/16", reason: "link local" },
  { cidr: "172.16.0.0/12", reason: "private use" },
  { cidr: "192.0.0.0/24", reason: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", reason: "documentation TEST-NET-1" },
  { cidr: "192.31.196.0/24", reason: "AS112 service" },
  { cidr: "192.52.193.0/24", reason: "AMT" },
  { cidr: "192.88.99.0/24", reason: "deprecated 6to4 relay" },
  { cidr: "192.168.0.0/16", reason: "private use" },
  { cidr: "192.175.48.0/24", reason: "AS112 service" },
  { cidr: "198.18.0.0/15", reason: "benchmarking" },
  { cidr: "198.51.100.0/24", reason: "documentation TEST-NET-2" },
  { cidr: "203.0.113.0/24", reason: "documentation TEST-NET-3" },
  { cidr: "224.0.0.0/4", reason: "multicast" },
  { cidr: "240.0.0.0/4", reason: "reserved" },
];

function ipv4Value(parts: readonly number[]): number {
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

const compiledIPv4Ranges = SPECIAL_USE_IPV4_RANGES.map(({ cidr }) => {
  const [base, prefixText] = cidr.split("/");
  const parts = parseStrictIPv4(base);
  if (!parts) throw new Error(`Invalid internal IPv4 CIDR: ${cidr}`);
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: ipv4Value(parts) & mask, mask };
});

/** True for malformed, non-global, or special-purpose IPv4 addresses. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = parseStrictIPv4(ip);
  if (!parts) return true;
  const value = ipv4Value(parts);
  return compiledIPv4Ranges.some(({ network, mask }) => (value & mask) === network);
}

export const SPECIAL_USE_IPV6_RANGES: readonly SpecialUseRange[] = [
  { cidr: "::/128", reason: "unspecified" },
  { cidr: "::1/128", reason: "loopback" },
  { cidr: "::/96", reason: "deprecated IPv4-compatible addressing" },
  { cidr: "::ffff:0:0/96", reason: "IPv4-mapped addressing" },
  { cidr: "::ffff:0:0:0/96", reason: "IPv4-translated addressing" },
  { cidr: "100::/64", reason: "discard only" },
  { cidr: "2001::/23", reason: "IETF protocol assignments" },
  { cidr: "2001:db8::/32", reason: "documentation" },
  { cidr: "2620:4f:8000::/48", reason: "AS112 service" },
  { cidr: "3fff::/20", reason: "documentation" },
  { cidr: "5f00::/16", reason: "segment routing SIDs" },
  { cidr: "fc00::/7", reason: "unique local" },
  { cidr: "fe80::/10", reason: "link local" },
  { cidr: "ff00::/8", reason: "multicast" },
];

function parseIPv6Value(ip: string): bigint | null {
  let cleaned = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const dotted = cleaned.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseStrictIPv4(dotted[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    cleaned = cleaned.slice(0, dotted.index) + `${hi}:${lo}`;
  }

  if ((cleaned.match(/::/g) ?? []).length > 1) return null;
  let groups: string[];
  if (cleaned.includes("::")) {
    const [left, right] = cleaned.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) return null;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = cleaned.split(":");
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

const compiledIPv6Ranges = SPECIAL_USE_IPV6_RANGES.map(({ cidr }) => {
  const [base, prefixText] = cidr.split("/");
  const value = parseIPv6Value(base);
  if (value === null) throw new Error(`Invalid internal IPv6 CIDR: ${cidr}`);
  return { value, prefix: Number(prefixText) };
});

function ipv4FromBits(bits: bigint): string {
  const n = Number(bits & 0xffffffffn);
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * IPv4 embedded in a NAT64/6to4 transition address, or null if the address
 * isn't one. These prefixes wrap an IPv4 address inside an IPv6 literal
 * (Round-3 finding C3-5): 64:ff9b::169.254.169.254 or 2002:a9fe:a9fe:: dials
 * the embedded IPv4 while looking like a benign IPv6 host — but the same
 * mechanisms wrap PUBLIC addresses legitimately (NAT64 is how IPv6-only
 * networks reach the IPv4 internet), so classification must follow the
 * embedded address, not the prefix.
 */
function embeddedTransitionIPv4(value: bigint): string | null {
  // NAT64 well-known prefix 64:ff9b::/96 (RFC6052): embedded v4 = low 32 bits.
  if (value >> 32n === 0x0064ff9bn << 64n) return ipv4FromBits(value);
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC8215): likewise low 32 bits.
  if (value >> 80n === 0x0064ff9b0001n) return ipv4FromBits(value);
  // 6to4 2002::/16 (RFC3056): embedded v4 = bits 16-47, i.e. groups 1-2.
  if (value >> 112n === 0x2002n) return ipv4FromBits(value >> 80n);
  return null;
}

/** True for malformed, non-global, or special-purpose IPv6 addresses. */
export function isPrivateIPv6(ip: string): boolean {
  const value = parseIPv6Value(ip);
  if (value === null) return true;

  // Transition addresses classify by their embedded IPv4: private/reserved/
  // metadata embeds are blocked, public embeds pass. This must short-circuit —
  // 64:ff9b::/96 sits outside global unicast 2000::/3, so falling through to
  // the fail-closed check below would re-block public NAT64.
  const embedded = embeddedTransitionIPv4(value);
  if (embedded !== null) return isPrivateIPv4(embedded);

  if (compiledIPv6Ranges.some(({ value: base, prefix }) => {
    const shift = BigInt(128 - prefix);
    return (value >> shift) === (base >> shift);
  })) return true;

  // Global unicast is currently 2000::/3. Everything else fails closed.
  return (value >> 125n) !== 0b001n;
}

/**
 * Loopback hostname aliases — pure synonyms of 127.0.0.1 / ::1.
 *
 * FALSE POSITIVE FIXED (C4): these four used to sit in BLOCKED_HOSTNAMES, a hard
 * "SSRF protection" deny, so `http://localhost:5173/` was refused OUTRIGHT while
 * the byte-identical `http://127.0.0.1:5173/` went through the port-checked
 * loopback path. The agent therefore could not fetch a page from the dev server
 * it had just started — and worse, its own `127.0.0.1:<selfPort>/apps/<id>/`
 * self-call was ALLOWED but 302'd to `http://localhost:<devPort>/…` (the
 * /apps reverse-proxy redirect), and the redirect re-check killed it on the
 * NAME. That is the app-build verify loop, broken by a synonym.
 *
 * A synonym of a literal must not be a different policy: network-policy routes
 * every member of this set through the SAME self-port + localServicePorts gate
 * as the literal, and then DENIES what those two allows didn't cover. So an
 * unregistered loopback port is still blocked — the deny is on the port now,
 * not on the name.
 *
 * ATTACK PRESERVED: none of these is an SSRF target. The real targets — cloud
 * metadata and the in-cluster K8s API — stay in BLOCKED_HOSTNAMES below, and
 * DNS rebinding (an ATTACKER-controlled name that RESOLVES to loopback/private)
 * is unaffected: resolveAndPinHost still resolves and rejects those, and it
 * never has to resolve a name on this list.
 */
export const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * True for a loopback destination, whether written as a literal address or as
 * one of its alias names. The single predicate consulted by BOTH loopback
 * carve-outs (self-port, localServicePorts) and the loopback deny that follows
 * them, so the name form and the literal form can never drift apart again.
 *
 * Deliberately narrow on the literal side (127.0.0.1 / ::1, not all of
 * 127.0.0.0/8): widening it would hand the self-port allow to 127.0.0.2:<port>,
 * which is not our server. The rest of 127/8 stays under isPrivateIPv4.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || LOOPBACK_HOSTNAMES.has(host);
}

/** Blocked hostnames: cloud-metadata and in-cluster-API endpoints — the actual
 *  SSRF targets this list exists for. Loopback aliases are NOT here; see
 *  LOOPBACK_HOSTNAMES above for why. */
export const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.internal",
  "metadata",
  "instance-data",                        // AWS EC2 metadata alias
  "kubernetes.default.svc",               // K8s in-cluster API
  "kubernetes.default",                    // K8s in-cluster API
]);
