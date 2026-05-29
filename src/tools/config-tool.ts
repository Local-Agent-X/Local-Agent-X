import { loadSettings, saveSettings } from '../settings.js';
import type { ToolDefinition, ToolResult } from '../types.js';

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (value !== '' && !isNaN(num)) return num;
  return value;
}

const configGet: ToolDefinition = {
  name: 'config_get',
  description:
    'Read agent configuration. Call with no args to see all settings, or with key="model" to get a specific value.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Specific setting key to read' },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const settings = loadSettings();
    const key = args.key as string | undefined;
    if (key) {
      const val = settings[key];
      if (val === undefined) return { content: `Key "${key}" is not set.` };
      return { content: JSON.stringify(val), metadata: { key, value: val } };
    }
    return { content: JSON.stringify(settings, null, 2) };
  },
};

const configSet: ToolDefinition = {
  name: 'config_set',
  description:
    'Update a configuration value. Example: key="temperature", value="0.5" or key="model", value="claude-sonnet-4-6"',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Setting key to update' },
      value: { type: 'string', description: 'New value (auto-coerced to boolean/number when possible)' },
    },
    required: ['key', 'value'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const key = args.key as string;
    const raw = args.value as string;
    if (!key || raw === undefined) {
      return { content: 'Both "key" and "value" are required.', isError: true };
    }
    const settings = { ...loadSettings() };
    const coerced = coerce(raw);
    settings[key] = coerced;
    saveSettings(settings);
    return { content: `Set "${key}" = ${JSON.stringify(coerced)}`, metadata: { key, value: coerced } };
  },
};

export const configTools: ToolDefinition[] = [configGet, configSet];
