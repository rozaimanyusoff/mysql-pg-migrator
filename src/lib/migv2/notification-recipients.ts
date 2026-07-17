export const MAX_NOTIFICATION_RECIPIENTS = 20;

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export interface NotificationRecipientResult {
  recipients: string[];
  invalid: string[];
  value: string | null;
  tooMany: boolean;
}

export function normalizeNotificationRecipients(input: string | null | undefined): NotificationRecipientResult {
  const entries = String(input ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const unique = new Map<string, string>();
  for (const entry of entries) if (!unique.has(entry.toLowerCase())) unique.set(entry.toLowerCase(), entry);
  const recipients = [...unique.values()];
  const invalid = recipients.filter(recipient => !EMAIL_PATTERN.test(recipient));
  return {
    recipients,
    invalid,
    value: recipients.length ? recipients.join(', ') : null,
    tooMany: recipients.length > MAX_NOTIFICATION_RECIPIENTS,
  };
}
