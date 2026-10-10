import { getCategory, type CategorySlug } from "../categories/catalog";
import { normalizeDescription } from "../transactions/normalize";

// Specific payment purposes precede merchant names. Never infer ownership from PIX/TED/bonifico alone.
const PURPOSES: readonly [CategorySlug, string][] = [
  ["card_payment", "PAGAMENTO DE FATURA|PAGAMENTO FATURA|PAGTO FATURA|PGTO FATURA|CREDIT CARD PAYMENT|SALDO CARTA DI CREDITO"],
  ["investment", "APLICACAO CDB|APLICACAO RDB|APLICACAO FINANCEIRA|RESGATE CDB|RESGATE RDB|RESGATE DE INVESTIMENTO|TESOURO DIRETO|ACQUISTO TITOLI|RISCATTO FONDI"],
  ["fx_exchange", "EXCHANGED TO|EXCHANGED FROM|CURRENCY EXCHANGE|FX EXCHANGE|CONVERSAO DE MOEDA"],
  ["refunds", "ESTORNO|REEMBOLSO|RIMBORSO|REFUND|CASHBACK"],
  ["salary", "SALARIO|STIPENDIO|EMOLUMENTI|PAYROLL|SALARY"],
  ["dividends", "DIVIDENDOS|DIVIDENDO|DIVIDENDI|DIVIDENDS|JCP|JUROS SOBRE CAPITAL"],
  ["interest", "RENDIMENTO|RENDIMENTOS|REMUNERACAO|INTERESSI ATTIVI|INTERESSI CREDITORI|INTEREST CREDIT"],
  ["loan_payment", "PARCELA EMPRESTIMO|PARCELA DE EMPRESTIMO|FINANCIAMENTO|RATA MUTUO|RATA PRESTITO|LOAN PAYMENT|MORTGAGE PAYMENT"],
  ["taxes", "IRRF|DARF|IPTU|IPVA|DAS SIMPLES NACIONAL|IMPOSTA DI BOLLO|AGENZIA DELLE ENTRATE|F24"],
  ["fees", "TARIFA|TARIFAS|IOF|JUROS DE MORA|JUROS ROTATIVO|ENCARGOS|COMMISSIONE|COMMISSIONI|INTERESSI PASSIVI|ACCOUNT FEE|MONTHLY FEE"],
  ["cash_withdrawal", "SAQUE|PRELIEVO|CASH WITHDRAWAL|ATM WITHDRAWAL"],
  ["housing", "ALUGUEL|AFFITTO|CONDOMINIO|SPESE CONDOMINIALI|RENT PAYMENT"],
  ["gifts_donations", "DOACAO|DONAZIONE|DONATION"],
];
const MERCHANTS: readonly [CategorySlug, string, string][] = [
  ["subscriptions", "Netflix", "NETFLIX"], ["subscriptions", "Spotify", "SPOTIFY"],
  ["subscriptions", "Amazon Prime", "AMAZON PRIME|AMZN PRIME|PRIME VIDEO"],
  ["subscriptions", "Apple", "APPLE.COM/BILL|APPLE COM BILL|ITUNES"],
  ["subscriptions", "Google", "YOUTUBE PREMIUM|GOOGLE ONE|GOOGLE WORKSPACE"],
  ["subscriptions", "OpenAI", "OPENAI|CHATGPT"], ["subscriptions", "Adobe", "ADOBE"],
  ["subscriptions", "Disney+", "DISNEYPLUS|DISNEY PLUS"],
  ["transport", "Uber", "UBER"], ["transport", "99", "99APP|99 POP|99POP"],
  ["dining", "Uber Eats", "UBER EATS|UBER *EATS|UBER*EATS"],
  ["dining", "iFood", "IFOOD|IFD"], ["dining", "McDonald's", "MCDONALDS|MC DONALDS"],
  ["groceries", "Esselunga", "ESSELUNGA"], ["groceries", "Lidl", "LIDL"],
  ["groceries", "Carrefour", "CARREFOUR"], ["groceries", "Conad", "CONAD"],
  ["groceries", "Eurospin", "EUROSPIN"], ["groceries", "Assaí", "ASSAI"],
  ["shopping", "Amazon", "AMAZON|AMZN"], ["shopping", "Mercado Livre", "MERCADO LIVRE|MERCADOLIVRE"],
  ["shopping", "Shopee", "SHOPEE"], ["shopping", "IKEA", "IKEA"],
  ["telecom", "TIM", "TIM"], ["telecom", "Vodafone", "VODAFONE"],
  ["telecom", "Claro", "CLARO"], ["telecom", "Vivo", "VIVO"],
  ["utilities", "Enel", "ENEL"], ["utilities", "Sabesp", "SABESP"],
  ["travel", "Airbnb", "AIRBNB"], ["travel", "Booking.com", "BOOKING.COM|BOOKING COM"],
];
const KEYWORDS: readonly [CategorySlug, string][] = [
  ["groceries", "SUPERMERCADO|SUPERMERCATO|SUPERMARKET|MERCEARIA|HORTIFRUTI|ALIMENTARI"],
  ["dining", "RESTAURANTE|RISTORANTE|TRATTORIA|OSTERIA|PIZZARIA|PIZZERIA|LANCHONETE|PADARIA|PASTICCERIA|BAKERY|RESTAURANT"],
  ["health", "FARMACIA|DROGARIA|PHARMACY|HOSPITAL|DENTISTA|DENTIST|CLINICA"],
  ["fuel", "POSTO DE COMBUSTIVEL|POSTO|CARBURANTE|CARBURANTI|GASOLINA|PETROL STATION"],
  ["transport", "ESTACIONAMENTO|PARCHEGGIO|PARKING|PEDAGIO|TAXI|METRO|TRENITALIA|ITALO"],
  ["utilities", "ENERGIA ELETRICA|CONTA DE LUZ|CONTA DE AGUA|BOLLETTA GAS|BOLLETTA LUCE|WATER BILL|ELECTRICITY"],
  ["education", "ESCOLA|UNIVERSIDADE|UNIVERSITA|SCUOLA|SCHOOL|TUITION"],
  ["personal_care", "BARBEARIA|CABELEIREIRO|PARRUCCHIERE|BARBER|SALAO DE BELEZA"],
  ["insurance", "SEGURO|ASSICURAZIONE|INSURANCE"],
  ["travel", "HOTEL|POUSADA|ALBERGO|HOSTEL"],
  ["entertainment", "CINEMA|TEATRO|THEATER|MUSEU|MUSEO"],
];
function tokens(text: string): string {
  return normalizeDescription(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function matches(text: string, patterns: string): boolean {
  return patterns.split("|").some((p) => ` ${text} `.includes(` ${tokens(p)} `));
}

/** Conservative defaults available even when AI is disabled or fails. */
export function recognizeCategory(description: string, amount: string): {
  categorySlug: CategorySlug; merchant: string | null; confidence: number;
} | null {
  const text = tokens(description);
  const incoming = !amount.trim().startsWith("-");
  const eligible = (slug: CategorySlug) => {
    const kind = getCategory(slug)!.kind;
    return kind === "transfer" || kind === (incoming ? "income" : "expense");
  };
  for (const [slug, patterns] of PURPOSES) {
    if (!matches(text, patterns)) continue;
    // An explicit purpose with incompatible direction must not fall through to a merchant.
    if (!eligible(slug)) return null;
    return { categorySlug: slug, merchant: null, confidence: 0.9 };
  }
  // Longest merchant alias wins (Uber Eats before Uber, Amazon Prime before Amazon).
  const merchants = MERCHANTS.flatMap(([slug, merchant, aliases]) =>
    aliases.split("|").map((alias) => ({ slug, merchant, alias })),
  ).sort((a, b) => tokens(b.alias).length - tokens(a.alias).length);
  for (const { slug, merchant, alias } of merchants) {
    if (matches(text, alias) && eligible(slug)) return { categorySlug: slug, merchant, confidence: 0.92 };
  }
  for (const [slug, patterns] of KEYWORDS) {
    if (eligible(slug) && matches(text, patterns)) return { categorySlug: slug, merchant: null, confidence: 0.85 };
  }
  return null;
}
