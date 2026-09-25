// Dates are plain "YYYY-MM-DD" strings; all math runs in UTC so DST/timezones never shift a day.
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const pad = (n: number) => String(n).padStart(2, "0");

function parse(s: string): Date {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s: string, n: number): string {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

// Next Saturday strictly after `from` (on a Saturday: the following one).
export function nextSaturday(from: string = today()): string {
  const dow = parse(from).getUTCDay();
  return addDays(from, (6 - dow + 7) % 7 || 7);
}

export function fmtDay(s: string): string {
  const d = parse(s);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
}

export const fmtRange = (a: string, b: string) => `${fmtDay(a)} – ${fmtDay(b)}`;
