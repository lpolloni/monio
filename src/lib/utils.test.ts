import { describe, expect, it } from "vitest";
import { monogram, prettyDescription } from "./utils";

describe("display helpers", () => {
  it("prettifies all-caps descriptions but keeps known acronyms", () => {
    expect(prettyDescription("PIX RECEBIDO CLIENTE ALFA SERVICOS LTDA")).toBe("PIX Recebido Cliente Alfa Servicos LTDA");
    expect(prettyDescription("RATA MUTUO N. 00123 CASA")).toBe("Rata Mutuo N. 00123 Casa");
    expect(prettyDescription("Netflix.com")).toBe("Netflix.com");
  });

  it("builds monograms", () => {
    expect(monogram("Monte dei Paschi")).toBe("MD");
    expect(monogram("N26")).toBe("N26");
  });
});
