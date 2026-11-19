/** Даты и часовые пояса. Внутри — миллисекунды UTC, наружу — местное время игры. */

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DAY = 86_400_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute };
}

function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/** Местные дата и время в поясе tz → момент UTC. */
export function localToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMs(guess, tz);
  let t = guess - off1;
  const off2 = offsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/** «2026-12-26T18:00» в поясе tz → UTC. null, если строка неверная. */
export function parseLocal(value: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const [y, mo, d, hh, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null;
  return localToUtc(y, mo, d, hh, mi, tz);
}

/** Сдвиг местной календарной даты на n дней. */
export function addLocalDays(p: LocalParts, n: number): LocalParts {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: p.hh, mm: p.mm };
}

export function atLocalTime(p: LocalParts, hh: number, mm: number, tz: string): number {
  return localToUtc(p.y, p.m, p.d, hh, mm, tz);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** «26 декабря (сб), 18:00» */
export function formatRu(utcMs: number, tz: string, withWeekday = true): string {
  const p = localParts(utcMs, tz);
  const wd = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  let s = `${p.d} ${MONTHS[p.m - 1]}`;
  if (withWeekday) s += ` (${wd})`;
  return `${s}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** Целых календарных дней от сегодня до даты события (по поясу игры). */
export function daysUntil(nowMs: number, eventMs: number, tz: string): number {
  const a = localParts(nowMs, tz);
  const b = localParts(eventMs, tz);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
}

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n);
  if (a % 10 === 1 && a % 100 !== 11) return forms[0];
  if (a % 10 >= 2 && a % 10 <= 4 && !(a % 100 >= 12 && a % 100 <= 14)) return forms[1];
  return forms[2];
}

export function daysWord(n: number): string {
  return `${n} ${plural(n, ["день", "дня", "дней"])}`;
}

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export { DAY };
