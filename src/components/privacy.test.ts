import { describe, expect, it } from "vitest";
import { maskFigures, PRIVACY_SCRIPT } from "./privacy";

describe("privacy mode", () => {
  it("replaces figures and keeps the currency and the words", () => {
    expect(maskFigures("R$ 1.234,56")).toBe("R$ •••••");
    expect(maskFigures("-€ 39,90")).toBe("-€ •••••");
    expect(maskFigures("O que é Mercado Bairro (-R$ 758,28)?")).toBe("O que é Mercado Bairro (-R$ •••••)?");
    expect(maskFigures("US$ 2.580,61 → US$ 3.000")).toBe("US$ ••••• → US$ •••••");
    expect(maskFigures("₲ 1.550.000")).toBe("₲ •••••");
    expect(maskFigures("sem valores")).toBe("sem valores");
  });

  it("applies the stored choice before the page paints, and survives a browser without storage", () => {
    const run = (stored: string | null | Error) => {
      const dataset: Record<string, string> = {};
      const localStorage = { getItem: () => { if (stored instanceof Error) throw stored; return stored; } };
      new Function("localStorage", "document", PRIVACY_SCRIPT)(localStorage, { documentElement: { dataset } });
      return dataset.privacy;
    };
    expect(run("hidden")).toBe("hidden");
    expect(run(null)).toBeUndefined();
    expect(run(new Error("blocked"))).toBeUndefined();
  });
});
