import { describe, expect, it } from "vitest";
import { dailyBalances, fillDaily } from "./balance-series";

const pairs = (points: { date: string; balance: string }[]) => points.map((p) => [p.date, p.balance]);

describe("daily balances from snapshots and movements", () => {
  const snapshots = [
    { asOf: "2026-07-01", balance: "502.62" },
    { asOf: "2026-07-31", balance: "0.16" },
  ];
  const movements = [
    { bookedOn: "2026-07-02", amount: "-8.55" },
    { bookedOn: "2026-07-02", amount: "1.69" },
    { bookedOn: "2026-07-03", amount: "4000" },
    { bookedOn: "2026-07-03", amount: "-3848.6" },
    { bookedOn: "2026-07-27", amount: "-647" },
  ];

  it("walks forward from a snapshot through every day with movements", () => {
    expect(pairs(dailyBalances(snapshots, movements))).toEqual([
      ["2026-07-01", "502.62"],
      ["2026-07-02", "495.76"],
      ["2026-07-03", "647.16"],
      ["2026-07-27", "0.16"],
      ["2026-07-31", "0.16"],
    ]);
  });

  it("walks backwards before the first snapshot, down to the day before the first movement", () => {
    expect(pairs(dailyBalances([{ asOf: "2026-07-31", balance: "0.16" }], movements))).toEqual([
      ["2026-07-01", "502.62"],
      ["2026-07-02", "495.76"],
      ["2026-07-03", "647.16"],
      ["2026-07-27", "0.16"],
      ["2026-07-31", "0.16"],
    ]);
  });

  it("lets a snapshot overrule the walk when movements are missing", () => {
    const series = dailyBalances(snapshots, movements.slice(0, 2));
    expect(pairs(series)).toEqual([["2026-07-01", "502.62"], ["2026-07-02", "495.76"], ["2026-07-31", "0.16"]]);
  });

  it("returns nothing without a snapshot: movements alone do not state a balance", () => {
    expect(dailyBalances([], movements)).toEqual([]);
  });

  it("does not walk forward from a snapshot older than the loaded movements", () => {
    const old = [{ asOf: "2026-05-31", balance: "100" }, ...snapshots];
    const series = dailyBalances(old, movements, { movementsFrom: "2026-07-01" });
    expect(pairs(series).slice(0, 3)).toEqual([["2026-05-31", "100"], ["2026-07-01", "502.62"], ["2026-07-02", "495.76"]]);
    const stale = dailyBalances([{ asOf: "2026-05-31", balance: "100" }], movements, { movementsFrom: "2026-07-01" });
    expect(pairs(stale)).toEqual([["2026-05-31", "100"]]);
  });

  it("fills every calendar day, carrying the last known balance forward", () => {
    const filled = fillDaily(dailyBalances(snapshots, movements));
    expect(filled).toHaveLength(31);
    expect(filled[10]).toEqual({ date: "2026-07-11", balance: "647.16" });
    expect(pairs(fillDaily(dailyBalances(snapshots, movements), "2026-07-26"))[0]).toEqual(["2026-07-26", "647.16"]);
  });
});
