export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthStart(key: string): string {
  return `${key}-01`;
}

export function monthEnd(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(last).padStart(2, "0")}`;
}

export function addMonthsToKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthsBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let k = fromKey;
  while (k <= toKey && out.length < 600) {
    out.push(k);
    k = addMonthsToKey(k, 1);
  }
  return out;
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * A month is complete when it has ended and the data covers it entirely
 * (latest imported data is on/after the month's last day). Incomplete months are
 * never compared as if they were complete.
 */
export function isMonthComplete(key: string, today: string, dataCoveredUntil: string | null): boolean {
  const end = monthEnd(key);
  if (end >= today) return false;
  return !!dataCoveredUntil && dataCoveredUntil >= end;
}
