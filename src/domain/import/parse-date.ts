export type DateOrder = "DMY" | "MDY" | "YMD";

const MONTHS: Record<string, number> = {
  // en
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // pt
  fev: 2, abr: 4, mai: 5, ago: 8, set: 9, out: 10, dez: 12,
  // it
  gen: 1, mag: 5, giu: 6, lug: 7, ott: 10, dic: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isValid(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

function expandYear(y: number): number {
  return y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
}

/**
 * Parses a date into ISO "YYYY-MM-DD". Supports numeric dates with / - . separators,
 * ISO timestamps, OFX compact dates (YYYYMMDD[HHMMSS]) and month names in EN/PT/IT
 * ("05 Mar 2026", "5 de março de 2026", "05-mag-2026").
 *
 * Numeric dates are interpreted using `order`; returns null when the value is not a
 * valid calendar date in that order. No timezone conversion is ever applied: the
 * calendar date written in the statement is the booked date.
 */
export function parseDate(raw: string | Date | null | undefined, order: DateOrder = "DMY"): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // Spreadsheet dates are stored as UTC midnight.
    return `${raw.getUTCFullYear()}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`;
  }
  const s = raw.trim();
  if (!s) return null;

  // ISO / ISO timestamp
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // OFX compact
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{0,6})?(?:\.\d+)?(?:\[.*\])?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // Numeric with separators
  m = s.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:\s.*)?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    let y: number, mo: number, d: number;
    if (m[1]!.length === 4) {
      [y, mo, d] = [a, b, c];
    } else if (order === "MDY") {
      [mo, d, y] = [a, b, expandYear(c)];
    } else {
      [d, mo, y] = [a, b, expandYear(c)];
    }
    return isValid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // Month names: "05 Mar 2026", "5 de março de 2026", "05-mag-2026", "Mar 5, 2026"
  const lower = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  m = lower.match(/^(\d{1,2})[\s\-/.]*(?:de\s+)?([a-z]{3,9})\.?[\s\-/.]*(?:de\s+)?(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3)] ?? MONTHS[m[2]!.slice(0, 4)];
    const d = Number(m[1]);
    const y = expandYear(Number(m[3]));
    return mo && isValid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = lower.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3)];
    const d = Number(m[2]);
    const y = Number(m[3]);
    return mo && isValid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null;
}

/**
 * Chooses DMY vs MDY for a column of numeric dates: any first component > 12
 * proves DMY, any second component > 12 proves MDY. Falls back to `fallback`.
 */
export function inferDateOrder(samples: Iterable<string>, fallback: DateOrder = "DMY"): DateOrder {
  let dmy = false;
  let mdy = false;
  for (const raw of samples) {
    const m = raw.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return "DMY";
  if (mdy && !dmy) return "MDY";
  return fallback;
}
