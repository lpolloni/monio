import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "../parse-document";
import type { LayoutMemory, LayoutRecipe } from "../parsers/layout-memory";
import { tableSignature } from "../parsers/layout-memory";
import type { TableColumnAssist } from "../parsers/types";

const csv = (text: string) => new TextEncoder().encode(text);

// Fictional export of a bank no profile knows: none of these header words is a known keyword.
const HEADERS = "Quando;Riferimento;Cosa;Quanto";
const march = csv(
  `Cassa Fittizia Boreale\nIBAN DE89370400440532013000\n\n${HEADERS}\n` +
    "02/03/2026;R-1;NEGOZIO FITTIZIO;-10,00\n" +
    "13/03/2026;R-2;STIPENDIO FITTIZIO;1.500,00\n" +
    "20/03/2026;R-3;AFFITTO FITTIZIO;-700,00\n",
);
const april = csv(`${HEADERS}\n03/04/2026;R-4;FARMACIA FITTIZIA;-25,50\n09/04/2026;R-5;STIPENDIO FITTIZIO;1.500,00\n`);

function memory(): LayoutMemory & { saved: Map<string, LayoutRecipe> } {
  const saved = new Map<string, LayoutRecipe>();
  return {
    saved,
    async load(kind) { return new Map([...saved].filter(([, r]) => r.kind === kind)) as never; },
    async save(signature, recipe) { saved.set(signature, recipe); },
    async forget(signature) { saved.delete(signature); },
  };
}

describe("tables with headers no profile recognizes", () => {
  it("cannot be read without help, and says so", async () => {
    const st = await parseDocument({ bytes: march, filename: "export.csv" });
    expect(st.accounts.flatMap((a) => a.transactions)).toEqual([]);
    expect(st.warnings.map((w) => w.code)).toContain("unsupported_layout");
  });

  it("asks the model which column is which, reads the values itself and remembers the layout", async () => {
    const layoutMemory = memory();
    const tableAssist = vi.fn<TableColumnAssist>(async () => ({ date: 0, description: 2, amount: 3 }));
    const st = await parseDocument({ bytes: march, filename: "export.csv" }, { tableAssist, layoutMemory, fallbackCurrency: "EUR" });

    // The model sees the header row and sample rows only.
    expect(tableAssist).toHaveBeenCalledOnce();
    expect(tableAssist.mock.calls[0]![0].headers).toEqual(HEADERS.split(";"));
    expect(tableAssist.mock.calls[0]![0].rows).toHaveLength(3);

    expect(st.profile).toBe("ai-table");
    expect(st.accounts[0]).toMatchObject({ identifier: "DE89370400440532013000" });
    expect(st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.description, t.sourceRow])).toEqual([
      ["2026-03-02", "-10", "NEGOZIO FITTIZIO", 5],
      ["2026-03-13", "1500", "STIPENDIO FITTIZIO", 6],
      ["2026-03-20", "-700", "AFFITTO FITTIZIO", 7],
    ]);
    expect(st.warnings.filter((w) => w.code === "unsupported_layout" || w.code === "balance_mismatch")).toEqual([]);
    expect([...layoutMemory.saved]).toEqual([[tableSignature(HEADERS.split(";")), { kind: "table", date: 0, description: 2, amount: 3 }]]);

    // Next file with the same header row: no model, same reading.
    const next = await parseDocument({ bytes: april, filename: "export-2.csv" }, { tableAssist, layoutMemory, fallbackCurrency: "EUR" });
    expect(tableAssist).toHaveBeenCalledOnce();
    expect(next.profile).toBe("learned-table");
    expect(next.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount])).toEqual([["2026-04-03", "-25.5"], ["2026-04-09", "1500"]]);
  });

  it("rejects a proposal whose columns do not hold what it claims, and remembers nothing", async () => {
    const layoutMemory = memory();
    // "Riferimento" is not a date column; "Cosa" is not an amount column.
    for (const proposal of [{ date: 1, description: 2, amount: 3 }, { date: 0, description: 1, amount: 2 }, { date: 0, description: 2, amount: 3, balance: 3 }, { date: 0, description: 2, amount: 3, balance: 1 }]) {
      const st = await parseDocument({ bytes: march, filename: "export.csv" }, { tableAssist: async () => proposal, layoutMemory });
      expect(st.accounts.flatMap((a) => a.transactions)).toEqual([]);
      expect(st.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["unsupported_layout", "ai_rejected_row"]));
    }
    expect(layoutMemory.saved.size).toBe(0);
  });

  it("forgets a remembered layout that no longer fits the data, and survives a failing model or memory", async () => {
    const layoutMemory = memory();
    layoutMemory.saved.set(tableSignature(HEADERS.split(";")), { kind: "table", date: 1, description: 2, amount: 3 });
    const st = await parseDocument({ bytes: march, filename: "export.csv" }, { layoutMemory, tableAssist: async () => { throw new Error("Fictional provider timeout"); } });
    expect(st.accounts.flatMap((a) => a.transactions)).toEqual([]);
    expect(layoutMemory.saved.size).toBe(0);

    const broken: LayoutMemory = { load: async () => { throw new Error("db down"); }, save: async () => { throw new Error("db down"); }, forget: async () => {} };
    const read = await parseDocument({ bytes: march, filename: "export.csv" }, { layoutMemory: broken, tableAssist: async () => ({ date: 0, description: 2, amount: 3 }), fallbackCurrency: "EUR" });
    expect(read.accounts[0]!.transactions).toHaveLength(3);
  });

  it("infers the columns without any model when a running balance proves them, and remembers them", async () => {
    const layoutMemory = memory();
    const tableAssist = vi.fn<TableColumnAssist>(async () => undefined);
    const signed = csv("Quando;Rif;Cosa;Quanto;Dopo\n02/03/2026;7;NEGOZIO FITTIZIO;-10,00;90,00\n13/03/2026;8;STIPENDIO FITTIZIO;1.500,00;1.590,00\n20/03/2026;9;AFFITTO FITTIZIO;-700,00;890,00\n");
    const st = await parseDocument({ bytes: signed, filename: "export.csv" }, { tableAssist, layoutMemory, fallbackCurrency: "EUR" });
    expect(tableAssist).not.toHaveBeenCalled();
    expect(st.profile).toBe("inferred-table");
    expect(st.accounts[0]).toMatchObject({ openingBalance: { amount: "100" }, closingBalance: { amount: "890" } });
    expect(st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.description])).toEqual([
      ["2026-03-02", "-10", "NEGOZIO FITTIZIO"], ["2026-03-13", "1500", "STIPENDIO FITTIZIO"], ["2026-03-20", "-700", "AFFITTO FITTIZIO"],
    ]);
    expect([...layoutMemory.saved.values()]).toEqual([{ kind: "table", date: 0, description: 2, amount: 3, balance: 4 }]);

    // Money out / money in columns, newest row first.
    const split = csv("Dia do registro,Texto,Sai,Entra,Posicao\n09/03/2026,ALUGUEL FICTICIO,1500.00,,2664.10\n05/03/2026,SALARIO FICTICIO LTDA,,3200.00,4164.10\n02/03/2026,MERCADO FICTICIO,35.90,,964.10\n");
    const second = await parseDocument({ bytes: split, filename: "novo-banco.csv" }, { fallbackCurrency: "BRL" });
    expect(second.profile).toBe("inferred-table");
    expect(second.accounts[0]!.transactions.map((t) => t.amount)).toEqual(["-35.9", "3200", "-1500"]);
    expect(second.accounts[0]).toMatchObject({ openingBalance: { amount: "1000" }, closingBalance: { amount: "2664.1" } });
  });

  it("infers nothing when no column is the running balance of another", async () => {
    const off = csv("Quando;Cosa;Quanto;Dopo\n02/03/2026;NEGOZIO FITTIZIO;-10,00;90,00\n13/03/2026;STIPENDIO FITTIZIO;1.500,00;1.600,00\n20/03/2026;AFFITTO FITTIZIO;-700,00;890,00\n");
    const st = await parseDocument({ bytes: off, filename: "export.csv" });
    expect(st.accounts.flatMap((a) => a.transactions)).toEqual([]);
    expect(st.warnings.map((w) => w.code)).toContain("unsupported_layout");
  });

  it("never involves the model or the memory for a layout a profile already reads", async () => {
    const tableAssist = vi.fn<TableColumnAssist>(async () => undefined);
    const layoutMemory = memory();
    const load = vi.spyOn(layoutMemory, "load");
    const st = await parseDocument({ bytes: csv("Data;Descrizione;Importo\n02/03/2026;NEGOZIO FITTIZIO;-10,00\n"), filename: "known.csv" }, { tableAssist, layoutMemory, fallbackCurrency: "EUR" });
    expect(st.accounts[0]!.transactions).toHaveLength(1);
    expect(tableAssist).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
