/**
 * Office calendar helpers. "Today" and report periods follow the office time
 * zone (TZ, Asia/Dubai by default), not UTC: a job closed at 01:30 on the
 * 1st in Dubai belongs to the 1st.
 */
export const officeTimeZone = (): string => process.env['TZ'] || 'Asia/Dubai';

/** YYYY-MM-DD in the office time zone. */
export function officeDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: officeTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Today's office date as a UTC-midnight Date, the form Prisma uses for
 * PostgreSQL DATE columns (due dates, deadlines), so they compare correctly.
 */
export function officeToday(d: Date = new Date()): Date {
  return new Date(`${officeDate(d)}T00:00:00.000Z`);
}

/** The instant an office calendar day (YYYY-MM-DD) starts. */
export function officeDayStart(date: string): Date {
  const utcMidnight = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  // Offset of the office zone at that moment (handles zones with daylight saving too).
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: officeTimeZone(),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMidnight))
      .map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return new Date(utcMidnight - (asLocal - utcMidnight));
}
