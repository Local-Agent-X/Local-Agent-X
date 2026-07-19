export interface PluginContributions {
  tools?: string[];
  secrets?: PluginSecretRequirement[];
}

export interface PluginSecretRequirement {
  name: string;
  service?: string;
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entryPoint: string;
  tools: string[];
  contributions?: PluginContributions;
  signature?: string;
  publisher?: string;
  keyId?: string;
}

const CONTRIBUTION_KEYS = new Set(["tools", "secrets"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function parseSecretRequirements(value: unknown): PluginSecretRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Plugin bundle secret contributions must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Plugin bundle secret requirement must be an object");
    }
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["name", "service", "description"].includes(key))) {
      throw new Error("Plugin bundle secret requirement contains an unknown field");
    }
    if (typeof raw.name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.name)) {
      throw new Error("Plugin bundle secret requirement name must be canonical");
    }
    if (seen.has(raw.name)) throw new Error("Plugin bundle contains duplicate secret requirements");
    seen.add(raw.name);
    if (raw.service !== undefined && (typeof raw.service !== "string" || !raw.service.trim())) {
      throw new Error("Plugin bundle secret requirement service is invalid");
    }
    if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description.trim())) {
      throw new Error("Plugin bundle secret requirement description is invalid");
    }
    return {
      name: raw.name,
      ...(raw.service !== undefined ? { service: raw.service as string } : {}),
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    };
  });
}

function parseContributions(value: unknown): PluginContributions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin bundle contributions must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !CONTRIBUTION_KEYS.has(key))) {
    throw new Error("Plugin bundle contains an unknown contribution type");
  }
  if (raw.tools !== undefined && !isStringArray(raw.tools)) {
    throw new Error("Plugin bundle tool contributions must be non-empty strings");
  }
  const secrets = parseSecretRequirements(raw.secrets);
  return {
    ...(raw.tools === undefined ? {} : { tools: raw.tools }),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

export function parsePluginManifest(data: unknown): PluginManifest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Manifest must be an object");
  }
  const raw = data as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error("Manifest id is required");
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Manifest name is required");
  if (typeof raw.version !== "string" || !raw.version.trim()) throw new Error("Manifest version is required");
  if (typeof raw.description !== "string") throw new Error("Manifest description is required");
  if (typeof raw.entryPoint !== "string" || !raw.entryPoint.trim()) throw new Error("Manifest entry point is required");
  if (raw.tools !== undefined && !isStringArray(raw.tools)) throw new Error("Manifest tools must be non-empty strings");

  const contributions = parseContributions(raw.contributions);
  const tools = [...(raw.tools as string[] | undefined ?? []), ...(contributions?.tools ?? [])];
  if (raw.tools === undefined && contributions?.tools === undefined) {
    throw new Error("Manifest tools or contributions.tools is required");
  }
  if (new Set(tools).size !== tools.length) {
    throw new Error("Plugin bundle contains duplicate tool contributions");
  }

  if (raw.signature !== undefined && typeof raw.signature !== "string") throw new Error("Manifest signature is invalid");
  if (raw.publisher !== undefined && typeof raw.publisher !== "string") throw new Error("Manifest publisher is invalid");
  if (raw.keyId !== undefined && typeof raw.keyId !== "string") throw new Error("Manifest keyId is invalid");
  if (raw.signature && !raw.publisher) throw new Error("Manifest publisher is required for signatures");
  if (typeof raw.publisher === "string" && !/^[a-zA-Z0-9._-]+$/.test(raw.publisher)) throw new Error("Manifest publisher is invalid");
  if (typeof raw.keyId === "string" && !/^[a-zA-Z0-9._-]+$/.test(raw.keyId)) throw new Error("Manifest keyId is invalid");
  if (typeof raw.signature === "string" && !/^[a-f0-9]+$/i.test(raw.signature)) throw new Error("Manifest signature is invalid");

  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    entryPoint: raw.entryPoint,
    tools,
    ...(contributions ? { contributions } : {}),
    ...(raw.signature !== undefined ? { signature: raw.signature as string } : {}),
    ...(raw.publisher !== undefined ? { publisher: raw.publisher as string } : {}),
    ...(raw.keyId !== undefined ? { keyId: raw.keyId as string } : {}),
  };
}
