import { isIP } from "node:net";

export interface ContainerNetworkIdentity { name: string; id: string; gateway?: string }
export interface ContainerConnectivityIdentity {
  network: ContainerNetworkIdentity | null;
  hostGateway: string | null;
}

export function configuredContainerNetwork(): ContainerNetworkIdentity | null {
  const name = process.env.LAX_CONTAINER_EXECUTION_NETWORK?.trim();
  const id = process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID?.trim();
  const gateway = process.env.LAX_CONTAINER_EXECUTION_NETWORK_GATEWAY?.trim();
  if (!name && !id) return null;
  if (!name || !id || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("container execution network requires an exact name and id");
  }
  if (gateway && isIP(gateway) === 0) throw new Error("container execution network gateway is invalid");
  return { name, id, ...(gateway ? { gateway } : {}) };
}

export function captureContainerConnectivity(localTarget: boolean): ContainerConnectivityIdentity {
  const network = configuredContainerNetwork();
  const hostGateway = localTarget ? validatedHostGateway() : null;
  if (localTarget && (!network?.gateway || !hostGateway || hostGateway !== network.gateway)) {
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
  if (isIP(gateway) === 0) throw new Error("container host gateway must be an inspected network gateway");
  return gateway;
}

export function isContainerConnectivityIdentity(value: unknown): value is ContainerConnectivityIdentity {
  const item = value as Partial<ContainerConnectivityIdentity> | null;
  const network = item?.network as Partial<ContainerNetworkIdentity> | null | undefined;
  return !!item && (item.hostGateway === null
    || typeof item.hostGateway === "string" && isIP(item.hostGateway) !== 0)
    && (network === null || !!network && typeof network.name === "string" && !!network.name
      && typeof network.id === "string" && /^[a-f0-9]{64}$/.test(network.id)
      && (network.gateway === undefined || typeof network.gateway === "string"
        && isIP(network.gateway) !== 0));
}
