import type { CronSchedule } from './types';

const DEFAULT_TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'Asia/Kuala_Lumpur';

function matchesField(value: number, expression: string, min: number, max: number, sundayAlias = false): boolean {
  return expression.split(',').some(part => {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart == null ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const [rawStart, rawEnd] = rangePart.split('-');
      start = Number(rawStart);
      end = rawEnd == null ? start : Number(rawEnd);
    }
    const validRange = Number.isInteger(start) && Number.isInteger(end)
      && start >= min && end <= max && start <= end
    if (!validRange) return false;
    const candidates = sundayAlias && value === 0 ? [0, 7] : [value];
    return candidates.some(candidate => candidate >= start && candidate <= end && (candidate - start) % step === 0);
  });
}

function zonedParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    minute: '2-digit', hour: '2-digit', hourCycle: 'h23',
    day: '2-digit', month: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day),
    month: Number(parts.month), weekday: weekdays[parts.weekday],
  };
}

export function normalizeScheduleTimezone(value: string | null | undefined): string {
  const timezone = value?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Invalid schedule timezone: ${timezone}`);
  }
}

export function cronMatches(expr: string, date: Date, timezone: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = fields;
  const parts = zonedParts(date, normalizeScheduleTimezone(timezone));
  const minute = matchesField(parts.minute, minuteExpr, 0, 59);
  const hour = matchesField(parts.hour, hourExpr, 0, 23);
  const month = matchesField(parts.month, monthExpr, 1, 12);
  const day = matchesField(parts.day, dayExpr, 1, 31);
  const weekday = matchesField(parts.weekday, weekdayExpr, 0, 7, true);
  const dayMatch = dayExpr === '*' ? weekday : weekdayExpr === '*' ? day : day || weekday;
  return minute && hour && month && dayMatch;
}

export function validateCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const probes = [
    [fields[0], 0, 59, false], [fields[1], 0, 23, false],
    [fields[2], 1, 31, false], [fields[3], 1, 12, false], [fields[4], 0, 7, true],
  ] as const;
  return probes.every(([field, min, max, sunday]) => {
    // A field is structurally valid when every list component describes a
    // wildcard, value, range, or stepped range within its allowed boundary.
    return field.split(',').every(part => {
      if (!/^(?:\*|\d+|\d+-\d+)(?:\/\d+)?$/.test(part)) return false;
      const [range, stepRaw] = part.split('/');
      if (stepRaw && Number(stepRaw) < 1) return false;
      const values = range === '*' ? [] : range.split('-').map(Number);
      return values.every(value => Number.isInteger(value) && value >= min && value <= max)
        && (values.length < 2 || values[0] <= values[1])
        && (!sunday || values.every(value => value <= 7));
    });
  });
}

export function scheduleIsDue(schedule: CronSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (schedule.scheduleMode === 'once') {
    const runAt = schedule.runAt ? Date.parse(schedule.runAt) : Number.NaN;
    return !schedule.triggeredAt && Number.isFinite(runAt) && runAt <= now.getTime();
  }
  if (schedule.pendingRunAt) return true;
  const thisMinute = now.toISOString().slice(0, 16);
  if (schedule.lastTriggeredAt?.slice(0, 16) === thisMinute) return false;
  return cronMatches(schedule.cronExpr, now, schedule.timezone ?? DEFAULT_TIMEZONE);
}
