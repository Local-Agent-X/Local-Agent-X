const CHILD_ENV_PASSTHROUGH = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT",
] as const;

export function qualificationChildEnv(
  source: NodeJS.ProcessEnv,
  required: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_PASSTHROUGH) {
    const match = Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase());
    if (match && source[match] !== undefined) env[name] = source[match];
  }
  return { ...env, ...required };
}
