/**
 * The "Compact at" setting's default and accepted range — a leaf, so the
 * settings schema (settings-schema.controls.ts) can validate the field without
 * importing the compaction policy, which reads settings itself.
 */

/** "Compact at" when the user has not set it: 90% of the measured window. */
export const DEFAULT_COMPACT_AT = 90;

/** Above 95 a single tool result could carry a turn past the window before the
 *  next check; below 50 is the churn the setting exists to end. */
export const COMPACT_AT_RANGE = { min: 50, max: 95 } as const;
