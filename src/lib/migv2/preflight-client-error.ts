import axios from 'axios';

export interface PreflightFailure {
  message: string;
  detail: string | null;
  stage: string | null;
  requestId: string | null;
}

interface PreflightErrorPayload {
  error?: unknown;
  detail?: unknown;
  stage?: unknown;
  requestId?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function describePreflightFailure(err: unknown): PreflightFailure {
  if (!axios.isAxiosError(err)) {
    return {
      message: 'Pre-flight failed unexpectedly.',
      detail: err instanceof Error ? err.message : String(err),
      stage: null,
      requestId: null,
    };
  }

  const payload = err.response?.data && typeof err.response.data === 'object'
    ? err.response.data as PreflightErrorPayload
    : null;
  const serverMessage = nonEmptyString(payload?.error);
  const serverDetail = nonEmptyString(payload?.detail);
  const stage = nonEmptyString(payload?.stage);
  const requestId = nonEmptyString(payload?.requestId);

  if (serverMessage) {
    return {
      message: serverMessage,
      detail: serverDetail && serverDetail !== serverMessage ? serverDetail : null,
      stage,
      requestId,
    };
  }

  const status = err.response?.status;
  if (status) {
    const rawBody = nonEmptyString(err.response?.data);
    const safeBody = rawBody && !/^\s*</.test(rawBody) ? rawBody.slice(0, 500) : null;
    return {
      message: `Pre-flight request failed (HTTP ${status}).`,
      detail: safeBody ?? err.message,
      stage: null,
      requestId: null,
    };
  }

  const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message);
  return {
    message: timedOut ? 'Pre-flight request timed out.' : 'Pre-flight server did not return a response.',
    detail: `${err.message}${err.code ? ` (${err.code})` : ''}`,
    stage: null,
    requestId: null,
  };
}
