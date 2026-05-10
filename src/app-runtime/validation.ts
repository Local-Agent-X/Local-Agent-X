import {
  ALLOWED_COMPONENT_TYPES,
  type AccessLevel,
  type AppDefinition,
  type ComponentDefinition,
  MAX_APP_DESC_LENGTH,
  MAX_APP_NAME_LENGTH,
  MAX_COMPONENTS,
  MAX_COMPONENT_ID_LENGTH,
} from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAppId(id: string): ValidationResult {
  const errors: string[] = [];
  if (!id) errors.push("App ID is required");
  if (id.length > 64) errors.push("App ID must be 64 characters or fewer");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) errors.push("App ID must start with alphanumeric and contain only [a-zA-Z0-9_-]");
  return { valid: errors.length === 0, errors };
}

export function validateComponent(comp: ComponentDefinition, depth = 0): ValidationResult {
  const errors: string[] = [];
  if (depth > 5) { errors.push(`Component nesting too deep (max 5 levels)`); return { valid: false, errors }; }
  if (!comp.id) errors.push("Component missing ID");
  if (comp.id && comp.id.length > MAX_COMPONENT_ID_LENGTH) errors.push(`Component ID "${comp.id}" exceeds ${MAX_COMPONENT_ID_LENGTH} chars`);
  if (!ALLOWED_COMPONENT_TYPES.has(comp.type)) errors.push(`Invalid component type "${comp.type}"`);
  if (comp.id && /[<>"'&]/.test(comp.id)) errors.push(`Component ID "${comp.id}" contains unsafe characters`);
  if (comp.children) {
    for (const child of comp.children) {
      const childResult = validateComponent(child, depth + 1);
      errors.push(...childResult.errors);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateAppDefinition(def: Partial<AppDefinition>): ValidationResult {
  const errors: string[] = [];

  if (def.id) {
    const idResult = validateAppId(def.id);
    errors.push(...idResult.errors);
  }

  if (def.name && def.name.length > MAX_APP_NAME_LENGTH) errors.push(`App name exceeds ${MAX_APP_NAME_LENGTH} chars`);
  if (def.description && def.description.length > MAX_APP_DESC_LENGTH) errors.push(`App description exceeds ${MAX_APP_DESC_LENGTH} chars`);

  if (def.components) {
    if (def.components.length > MAX_COMPONENTS) errors.push(`Too many components (max ${MAX_COMPONENTS})`);
    const ids = new Set<string>();
    for (const comp of def.components) {
      const compResult = validateComponent(comp);
      errors.push(...compResult.errors);
      if (comp.id) {
        if (ids.has(comp.id)) errors.push(`Duplicate component ID "${comp.id}"`);
        ids.add(comp.id);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function meetsAccessLevel(has: AccessLevel, needs: AccessLevel): boolean {
  const levels: Record<AccessLevel, number> = { read: 1, write: 2, admin: 3 };
  return levels[has] >= levels[needs];
}
