const LOCAL_MODEL_QUALIFICATION_BOOT_ENV = "LAX_LOCAL_MODEL_QUALIFICATION_BOOT";

/** True only for the opt-in, isolated product child used by local-model qualification. */
export function isLocalModelQualificationBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_MODEL_QUALIFICATION_BOOT_ENV] === "1";
}
