// Central model config for the AI Migration module.
//
// Standardised on Haiku 4.5 — fast and cheap, and sufficient for this module's
// bounded schema-mapping / explanation tasks. Override per-deployment via env
// without touching code.
export const AI_MIGRATION_MODEL =
  process.env.AI_MIGRATION_MODEL || 'claude-haiku-4-5-20251001';

// `generate-job` emits the job config that drives a real migration — the
// highest-stakes call. Defaults to the shared model but can be bumped
// independently (e.g. to a Sonnet/Opus id) without a code change if its output
// quality ever slips.
export const AI_MIGRATION_MODEL_GENERATE =
  process.env.AI_MIGRATION_MODEL_GENERATE || AI_MIGRATION_MODEL;
