import { D, dec, toPlain, type DecimalValue } from "../money/decimal";
import { addDaysIso } from "./periods";

export interface BalanceSnapshot {
  asOf: string;
  balance: string;
}

export interface BalanceMovement {
  bookedOn: string;
  amount: string;
}

export interface DailyBalance {
  date: string;
  balance: string;
}

/**
 * End-of-day balances of one account on every day something is known: its
 * balance snapshots (statement opening/closing balances) and the days between
 * and around them on which a movement was booked.
 *
 * Snapshots are authoritative on their own day. Between two snapshots the
 * balance walks forward from the earlier one; before the first snapshot it
 * walks backwards from it. Without any snapshot nothing is returned: movements
 * alone do not say what the balance was.
 *
 * `movementsFrom` is the first day the given movements cover. A snapshot older
 * than the day before it cannot be walked forward (movements are missing in
 * between), so the days after it stay unknown until the next snapshot.
 */
export function dailyBalances(snapshots: BalanceSnapshot[], movements: BalanceMovement[], options: { movementsFrom?: string } = {}): DailyBalance[] {
  const anchors = new Map([...snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf)).map((s) => [s.asOf, s.balance]));
  const first = [...anchors.keys()][0];
  if (first === undefined) return [];
  const moved = new Map<string, DecimalValue>();
  for (const m of movements) moved.set(m.bookedOn, (moved.get(m.bookedOn) ?? new D(0)).plus(dec(m.amount)));
  const days = [...new Set([...anchors.keys(), ...moved.keys()])].sort();
  const out: DailyBalance[] = [];

  // Backwards from the first snapshot: the close of a day is the close of the
  // next known day minus what was booked on that next day.
  let running = dec(anchors.get(first)!);
  let next = first;
  const earlier = days.filter((d) => d < first).reverse();
  for (const day of earlier) {
    running = running.minus(moved.get(next) ?? 0);
    out.unshift({ date: day, balance: toPlain(running) });
    next = day;
  }
  const earliest = earlier.at(-1);
  if (earliest) out.unshift({ date: addDaysIso(earliest, -1), balance: toPlain(running.minus(moved.get(earliest)!)) });

  const coveredFrom = options.movementsFrom ? addDaysIso(options.movementsFrom, -1) : undefined;
  let walkable = false;
  for (const day of days) {
    if (day < first) continue;
    const snapshot = anchors.get(day);
    if (snapshot !== undefined) {
      running = dec(snapshot);
      walkable = coveredFrom === undefined || day >= coveredFrom;
    } else if (walkable) running = running.plus(moved.get(day)!);
    else continue;
    out.push({ date: day, balance: toPlain(running) });
  }
  return out;
}

/** One point per calendar day from the first to the last known balance, carrying the last known one forward. */
export function fillDaily(points: DailyBalance[], from?: string): DailyBalance[] {
  const last = points.at(-1);
  if (!last) return [];
  const known = new Map(points.map((p) => [p.date, p.balance]));
  const out: DailyBalance[] = [];
  let balance: string | undefined;
  for (const p of points) if (from && p.date < from) balance = p.balance;
  const start = from && from > points[0]!.date ? from : points[0]!.date;
  for (let day = start; day <= last.date && out.length < 5000; day = addDaysIso(day, 1)) {
    balance = known.get(day) ?? balance;
    if (balance !== undefined) out.push({ date: day, balance });
  }
  return out;
}
