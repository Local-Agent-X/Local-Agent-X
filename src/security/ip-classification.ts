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
  { cidr: "64:ff9b::/96", reason: "IPv4/IPv6 translation" },
  { cidr: "64:ff9b:1::/48", reason: "local IPv4/IPv6 translation" },
  { cidr: "100::/64", reason: "discard only" },
  { cidr: "2001::/23", reason: "IETF protocol assignments" },
  { cidr: "2001:db8::/32", reason: "documentation" },
  { cidr: "2002::/16", reason: "6to4" },
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

/** True for malformed, non-global, or special-purpose IPv6 addresses. */
export function isPrivateIPv6(ip: string): boolean {
  const value = parseIPv6Value(ip);
  if (value === null) return true;

  if (compiledIPv6Ranges.some(({ value: base, prefix }) => {
    const shift = BigInt(128 - prefix);
    return (value >> shift) === (base >> shift);
  })) return true;

  // Global unicast is currently 2000::/3. Everything else fails closed.
  return (value >> 125n) !== 0b001n;
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
