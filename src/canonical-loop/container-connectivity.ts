import { isIP } from "node:net";

export interface ContainerNetworkIdentity { name: string; id: string }
export interface ContainerConnectivityIdentity {
  network: ContainerNetworkIdentity | null;
  hostGateway: string | null;
}

export function configuredContainerNetwork(): ContainerNetworkIdentity | null {
  const name = process.env.LAX_CONTAINER_EXECUTION_NETWORK?.trim();
  const id = process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID?.trim();
  if (!name && !id) return null;
  if (!name || !id || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("container execution network requires an exact name and id");
  }
  return { name, id };
}

export function captureContainerConnectivity(localTarget: boolean): ContainerConnectivityIdentity {
  const network = configuredContainerNetwork();
  const hostGateway = localTarget ? validatedHostGateway() : null;
  if (localTarget && (!network || !hostGateway)) {
    throw new Error("local container execution requires an explicit host gateway and network");
  }
  return { network, hostGateway };
}

export function assertCurrentContainerConnectivity(expected: ContainerConnectivityIdentity): void {
  const current = {
    network: configuredContainerNetwork(),
    hostGateway: expected.hostGateway === null ? null : validatedHostGateway(),
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("container execution connectivity identity changed");
  }
}

export function validatedHostGateway(): string | null {
  const gateway = process.env.LAX_CONTAINER_HOST_GATEWAY?.trim();
  if (!gateway) return null;
  if (gateway === "host.docker.internal") return gateway;
  const address = gateway.startsWith("[") && gateway.endsWith("]")
    ? gateway.slice(1, -1) : gateway;
  const family = isIP(address);
  if (family === 4 && isPrivateIpv4(address)) return gateway;
  if (family === 6 && /^(?:f[cd]|fe[89ab])/i.test(address)) return gateway;
  throw new Error("container host gateway is not host-local");
}

export function isContainerConnectivityIdentity(value: unknown): value is ContainerConnectivityIdentity {
  const item = value as Partial<ContainerConnectivityIdentity> | null;
  const network = item?.network as Partial<ContainerNetworkIdentity> | null | undefined;
  return !!item && (item.hostGateway === null || item.hostGateway === "host.docker.internal"
    || typeof item.hostGateway === "string" && isHostLocalLiteral(item.hostGateway))
    && (network === null || !!network && typeof network.name === "string" && !!network.name
      && typeof network.id === "string" && /^[a-f0-9]{64}$/.test(network.id));
}

function isPrivateIpv4(value: string): boolean {
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 169 && b === 254;
}

function isHostLocalLiteral(value: string): boolean {
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(address) === 4 ? isPrivateIpv4(address)
    : isIP(address) === 6 && /^(?:f[cd]|fe[89ab])/i.test(address);
}
