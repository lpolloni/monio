import { monogram } from "./utils";

const SHORT_LABELS: Record<string, string> = {
  nubank: "Nu",
  "nubank-pj": "PJ",
  xp: "XP",
  "santander-br": "S",
  itau: "Itaú",
  bradesco: "B",
  "banco-do-brasil": "BB",
  inter: "In",
  "bbva-it": "BBVA",
  n26: "N26",
  revolut: "R",
  mps: "MPS",
  "intesa-sanpaolo": "IS",
  unicredit: "UC",
  fineco: "F",
  wise: "W",
};

/** Compact label shown inside institution bodies and avatars. */
export function institutionShortLabel(slug: string | null | undefined, name: string, kind?: "bitcoin" | "evm" | null): string {
  if (kind === "bitcoin") return "₿";
  if (kind === "evm") return "Ξ";
  if (slug && SHORT_LABELS[slug]) return SHORT_LABELS[slug]!;
  return monogram(name);
}
