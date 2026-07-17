const TRANSIENT_ERROR_PATTERNS = [
  /\bECONN(?:RESET|REFUSED|ABORTED)\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /PROTOCOL_CONNECTION_LOST/i,
  /connection (?:was )?(?:closed|lost|terminated)/i,
  /server closed the connection/i,
  /terminating connection due to administrator command/i,
  /remaining connection slots are reserved/i,
  /too many connections/i,
  /deadlock detected/i,
  /serialization failure/i,
  /could not serialize access/i,
  /lock wait timeout/i,
  /temporary failure/i,
];

const TRANSIENT_ERROR_CODES = new Set([
  '40001', // PostgreSQL serialization_failure
  '40P01', // PostgreSQL deadlock_detected
  '53300', // PostgreSQL too_many_connections
  '57P01', // PostgreSQL admin_shutdown
  '1205',  // MySQL lock wait timeout
  '1213',  // MySQL deadlock
]);

export const MAX_TRANSIENT_RETRIES = 3;

export function isTransientMigrationError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if ([candidate?.code, candidate?.errno].some(code => code != null && TRANSIENT_ERROR_CODES.has(String(code).toUpperCase()))) return true;
  const text = [candidate?.code, candidate?.errno, candidate?.message, error]
    .filter(value => value != null)
    .map(String)
    .join(' ');
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

export function transientRetryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(MAX_TRANSIENT_RETRIES, Math.floor(attempt)));
  return 1_000 * (2 ** (boundedAttempt - 1));
}
