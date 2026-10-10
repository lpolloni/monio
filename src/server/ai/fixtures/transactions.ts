/**
 * Deterministic merchant/category fixtures used by the mock AI provider.
 *
 * Rules are evaluated in array order (first match wins), so specific rules
 * come before generic ones. Patterns are matched on whole normalized tokens
 * (see `normalizeDescription` in providers/mock.ts): "prefix" = the pattern
 * tokens start the description, "contains" = they appear contiguously
 * anywhere. Confidence values are SIMULATED, not calibrated.
 */
import type { CategorySlug } from "@/domain/categories/catalog";

export interface FixtureOutcome {
  merchant: string | null;
  category: CategorySlug | null;
  recurring: boolean;
  transfer: boolean;
  confidence: number;
}

export interface TransactionFixture extends FixtureOutcome {
  id: string;
  match: "prefix" | "contains";
  patterns: readonly string[];
  /** Overrides applied when money comes in / goes out. */
  incoming?: Partial<FixtureOutcome>;
  outgoing?: Partial<FixtureOutcome>;
  region: "BR" | "IT" | "EU" | "GLOBAL";
}

type RuleOptions = Partial<Pick<TransactionFixture, "match" | "recurring" | "transfer" | "incoming" | "outgoing">>;

function rule(
  id: string,
  region: TransactionFixture["region"],
  patterns: readonly string[],
  merchant: string | null,
  category: CategorySlug | null,
  confidence: number,
  options: RuleOptions = {},
): TransactionFixture {
  return {
    id,
    region,
    patterns,
    merchant,
    category,
    confidence,
    match: options.match ?? "contains",
    recurring: options.recurring ?? false,
    transfer: options.transfer ?? false,
    ...(options.incoming && { incoming: options.incoming }),
    ...(options.outgoing && { outgoing: options.outgoing }),
  };
}

const R = { recurring: true } as const;

export const TRANSACTION_FIXTURES: readonly TransactionFixture[] = [
  // --- Income, bank movements and fees (before merchants: their words are more telling) ---
  rule("salary", "GLOBAL", ["PAGAMENTO SALARIO", "SALARIO", "STIPENDIO", "ACCREDITO STIPENDIO", "EMOLUMENTI", "SALARY", "PAYROLL", "FOLHA PAGAMENTO"], null, "salary", 0.95, R),
  rule("card-bill-payment", "GLOBAL", ["PAGAMENTO DE FATURA", "PAGAMENTO FATURA", "PAGTO FATURA", "PGTO FATURA", "PAG FATURA", "CREDIT CARD PAYMENT", "SALDO CARTA DI CREDITO", "ADDEBITO SALDO CARTA"], null, "card_payment", 0.95, { transfer: true }),
  rule("dividends", "GLOBAL", ["DIVIDENDOS", "DIVIDENDO", "DIVIDENDI", "DIVIDEND", "DIVIDENDS", "JCP", "JUROS SOBRE CAPITAL", "JUROS S CAPITAL"], null, "dividends", 0.95),
  rule("income-tax-withholding", "BR", ["IR SOBRE RENDIMENTO", "IRRF"], null, "taxes", 0.92),
  rule("interest-paid-it", "IT", ["INTERESSI PASSIVI", "INTERESSI DEBITORI"], null, "fees", 0.9),
  rule("interest-earned", "GLOBAL", ["RENDIMENTO", "RENDIMENTOS", "REMUNERACAO", "INTERESSI ATTIVI", "INTERESSI CREDITORI", "INTERESSI", "INTEREST"], null, "interest", 0.92, {
    recurring: true,
    outgoing: { category: "fees", recurring: false, confidence: 0.6 },
  }),
  rule("interest-charged-br", "BR", ["JUROS", "JUROS ROTATIVO", "JUROS DE MORA", "ENCARGOS"], null, "fees", 0.85, {
    incoming: { category: "interest", confidence: 0.6 },
  }),
  rule("taxes", "GLOBAL", ["DARF", "F24", "DAS SIMPLES NACIONAL", "GNRE", "IPVA", "IPTU", "IMPOSTA DI BOLLO", "BOLLO AUTO", "AGENZIA ENTRATE", "AGENZIA DELLE ENTRATE", "CANONE RAI", "IMPOSTO", "TASSA"], null, "taxes", 0.93),
  rule("housing", "GLOBAL", ["ALUGUEL", "AFFITTO", "CONDOMINIO", "SPESE CONDOMINIALI", "QUINTOANDAR", "QUINTO ANDAR", "MONTHLY RENT", "RENT PAYMENT"], null, "housing", 0.9, {
    recurring: true,
    incoming: { category: "other_income", confidence: 0.6 },
  }),
  rule("fees-recurring", "GLOBAL", ["CANONE", "TARIFA PACOTE", "CESTA DE SERVICOS", "ANUIDADE", "SPESE TENUTA CONTO", "MONTHLY FEE", "ACCOUNT FEE"], null, "fees", 0.9, R),
  rule("fees", "GLOBAL", ["IOF", "TARIFA", "COMMISSIONI", "COMMISSIONE", "FEE"], null, "fees", 0.88),
  rule("cash-withdrawal", "GLOBAL", ["SAQUE", "PRELIEVO", "PRELIEVO BANCOMAT", "ATM WITHDRAWAL", "CASH WITHDRAWAL"], null, "cash_withdrawal", 0.95, {
    incoming: { category: null, confidence: 0.3 },
  }),
  rule("investment", "BR", ["APLICACAO", "RESGATE", "TESOURO DIRETO", "CDB"], null, "investment", 0.85, { transfer: true }),
  rule("fx-exchange", "GLOBAL", ["CAMBIO", "CURRENCY EXCHANGE", "EXCHANGED TO", "FX EXCHANGE"], null, "fx_exchange", 0.85, { transfer: true }),
  rule("nubank-pj", "BR", ["NUBANK PJ", "NU PJ", "NU PAGAMENTOS PJ"], null, null, 0.4, {
    incoming: { category: "business_income", confidence: 0.75 },
    outgoing: { category: "business_expenses", confidence: 0.5 },
  }),
  rule("freelance-platforms", "GLOBAL", ["UPWORK", "FIVERR"], null, "freelance", 0.75, {
    outgoing: { category: "fees", confidence: 0.6 },
  }),
  rule("donations", "GLOBAL", ["DOACAO", "DONAZIONE", "DONATION"], null, "gifts_donations", 0.85, {
    incoming: { category: "other_income", confidence: 0.5 },
  }),

  // --- Subscriptions / digital services ---
  rule("netflix", "GLOBAL", ["NETFLIX"], "Netflix", "subscriptions", 0.98, R),
  rule("spotify", "GLOBAL", ["SPOTIFY"], "Spotify", "subscriptions", 0.98, R),
  rule("apple-bill", "GLOBAL", ["APPLE COM BILL", "APPLE COM", "ITUNES"], "Apple", "subscriptions", 0.95, R),
  rule("youtube", "GLOBAL", ["GOOGLE YOUTUBE", "YOUTUBE PREMIUM", "YOUTUBE"], "YouTube Premium", "subscriptions", 0.96, R),
  rule("google-one", "GLOBAL", ["GOOGLE ONE", "GOOGLE STORAGE"], "Google One", "subscriptions", 0.95, R),
  rule("amazon-prime", "GLOBAL", ["AMAZON PRIME", "AMZN PRIME", "PRIME VIDEO", "PRIMEVIDEO"], "Amazon Prime", "subscriptions", 0.96, R),
  rule("disney-plus", "GLOBAL", ["DISNEY PLUS", "DISNEYPLUS", "DISNEY"], "Disney+", "subscriptions", 0.96, R),
  rule("max", "GLOBAL", ["HBO MAX", "HBOMAX"], "Max", "subscriptions", 0.95, R),
  rule("globoplay", "BR", ["GLOBOPLAY"], "Globoplay", "subscriptions", 0.95, R),
  rule("dazn", "EU", ["DAZN"], "DAZN", "subscriptions", 0.95, R),
  rule("deezer", "GLOBAL", ["DEEZER"], "Deezer", "subscriptions", 0.95, R),
  rule("openai", "GLOBAL", ["CHATGPT", "OPENAI"], "OpenAI", "subscriptions", 0.96, R),
  rule("github", "GLOBAL", ["GITHUB"], "GitHub", "subscriptions", 0.95, R),
  rule("adobe", "GLOBAL", ["ADOBE"], "Adobe", "subscriptions", 0.95, R),
  rule("microsoft-365", "GLOBAL", ["MICROSOFT 365", "OFFICE 365"], "Microsoft 365", "subscriptions", 0.94, R),
  rule("dropbox", "GLOBAL", ["DROPBOX"], "Dropbox", "subscriptions", 0.95, R),
  rule("duolingo", "GLOBAL", ["DUOLINGO"], "Duolingo", "education", 0.9, R),

  // --- Mobility & food delivery ---
  rule("uber-eats", "GLOBAL", ["UBER EATS", "UBEREATS"], "Uber Eats", "dining", 0.95),
  rule("uber", "GLOBAL", ["UBER TRIP", "UBER"], "Uber", "transport", 0.93),
  rule("99", "BR", ["99APP", "99POP", "99TAXI"], "99", "transport", 0.93),
  rule("bolt", "EU", ["BOLT"], "Bolt", "transport", 0.9),
  rule("freenow", "EU", ["FREENOW", "FREE NOW"], "FREENOW", "transport", 0.92),
  rule("ifood", "BR", ["IFOOD", "IFD"], "iFood", "dining", 0.96),
  rule("rappi", "BR", ["RAPPI"], "Rappi", "dining", 0.94),
  rule("ze-delivery", "BR", ["ZEDELIVERY", "ZE DELIVERY"], "Zé Delivery", "groceries", 0.93),
  rule("deliveroo", "EU", ["DELIVEROO"], "Deliveroo", "dining", 0.95),
  rule("glovo", "EU", ["GLOVO"], "Glovo", "dining", 0.95),
  rule("just-eat", "EU", ["JUST EAT", "JUSTEAT"], "Just Eat", "dining", 0.95),
  rule("mcdonalds", "GLOBAL", ["MCDONALDS", "MCDONALD", "MC DONALDS"], "McDonald's", "dining", 0.94),
  rule("starbucks", "GLOBAL", ["STARBUCKS"], "Starbucks", "dining", 0.94),

  // --- Groceries ---
  rule("carrefour-market", "IT", ["CARREFOUR MARKET"], "Carrefour Market", "groceries", 0.95),
  rule("carrefour", "GLOBAL", ["CARREFOUR"], "Carrefour", "groceries", 0.93),
  rule("pao-de-acucar", "BR", ["PAO DE ACUCAR", "PAODEACUCAR"], "Pão de Açúcar", "groceries", 0.95),
  rule("assai", "BR", ["ASSAI ATACADISTA", "ASSAI"], "Assaí Atacadista", "groceries", 0.95),
  rule("atacadao", "BR", ["ATACADAO"], "Atacadão", "groceries", 0.94),
  rule("esselunga", "IT", ["ESSELUNGA"], "Esselunga", "groceries", 0.97),
  rule("conad", "IT", ["CONAD"], "Conad", "groceries", 0.96),
  rule("coop", "IT", ["COOP"], "Coop", "groceries", 0.93),
  rule("lidl", "EU", ["LIDL"], "Lidl", "groceries", 0.96),
  rule("eurospin", "IT", ["EUROSPIN"], "Eurospin", "groceries", 0.95),
  rule("aldi", "EU", ["ALDI"], "Aldi", "groceries", 0.95),

  // --- Health ---
  rule("droga-raia", "BR", ["DROGA RAIA", "DROGARAIA"], "Droga Raia", "health", 0.95),
  rule("drogasil", "BR", ["DROGASIL"], "Drogasil", "health", 0.95),
  rule("pague-menos", "BR", ["PAGUE MENOS"], "Pague Menos", "health", 0.93),
  rule("pharmacy", "GLOBAL", ["FARMACIA", "DROGARIA", "PHARMACY"], null, "health", 0.85),
  rule("smart-fit", "BR", ["SMART FIT", "SMARTFIT"], "Smart Fit", "health", 0.93, R),
  rule("wellhub", "GLOBAL", ["GYMPASS", "WELLHUB"], "Wellhub", "health", 0.93, R),

  // --- Fuel ---
  rule("ipiranga", "BR", ["POSTO IPIRANGA", "IPIRANGA"], "Ipiranga", "fuel", 0.93),
  rule("shell", "GLOBAL", ["SHELL"], "Shell", "fuel", 0.92),
  rule("petrobras", "BR", ["PETROBRAS"], "Petrobras", "fuel", 0.92),
  rule("eni-plenitude", "IT", ["ENI PLENITUDE", "PLENITUDE"], "Eni Plenitude", "utilities", 0.93, R),
  rule("eni", "IT", ["ENILIVE", "ENI STATION", "ENI"], "Eni", "fuel", 0.9),
  rule("ip-italiana-petroli", "IT", ["ITALIANA PETROLI"], "IP", "fuel", 0.92),
  rule("ip", "IT", ["IP"], "IP", "fuel", 0.85, { match: "prefix" }),
  rule("q8", "IT", ["Q8"], "Q8", "fuel", 0.9),
  rule("esso", "GLOBAL", ["ESSO"], "Esso", "fuel", 0.9),

  // --- Telecom ---
  rule("vivo", "BR", ["TELEFONICA BRASIL", "VIVO"], "Vivo", "telecom", 0.93, R),
  rule("claro", "BR", ["CLARO"], "Claro", "telecom", 0.92, R),
  rule("tim", "GLOBAL", ["TIM CELULAR", "TIM"], "TIM", "telecom", 0.9, R),
  rule("fastweb", "IT", ["FASTWEB"], "Fastweb", "telecom", 0.95, R),
  rule("iliad", "IT", ["ILIAD"], "Iliad", "telecom", 0.95, R),
  rule("windtre", "IT", ["WINDTRE", "WIND TRE"], "WindTre", "telecom", 0.94, R),
  rule("vodafone", "EU", ["VODAFONE"], "Vodafone", "telecom", 0.94, R),

  // --- Utilities ---
  rule("enel", "GLOBAL", ["ENEL"], "Enel", "utilities", 0.94, R),
  rule("sabesp", "BR", ["SABESP"], "Sabesp", "utilities", 0.96, R),
  rule("cemig", "BR", ["CEMIG"], "Cemig", "utilities", 0.96, R),
  rule("copel", "BR", ["COPEL"], "Copel", "utilities", 0.95, R),
  rule("comgas", "BR", ["COMGAS"], "Comgás", "utilities", 0.95, R),
  rule("iren", "IT", ["IREN"], "Iren", "utilities", 0.94, R),
  rule("a2a", "IT", ["A2A ENERGIA", "A2A"], "A2A Energia", "utilities", 0.94, R),
  rule("hera", "IT", ["HERA COMM", "HERA"], "Hera", "utilities", 0.92, R),
  rule("acea", "IT", ["ACEA"], "Acea", "utilities", 0.93, R),

  // --- Transport ---
  rule("trenitalia", "IT", ["TRENITALIA"], "Trenitalia", "transport", 0.96),
  rule("italo", "IT", ["ITALO TRENO", "ITALO", "NTV"], "Italo", "transport", 0.93),
  rule("atm-milano", "IT", ["ATM MILANO", "ATM SPA"], "ATM Milano", "transport", 0.94),
  rule("telepass", "IT", ["TELEPASS"], "Telepass", "transport", 0.93, R),
  rule("autostrade", "IT", ["AUTOSTRADE"], "Autostrade per l'Italia", "transport", 0.92),
  rule("sem-parar", "BR", ["SEM PARAR"], "Sem Parar", "transport", 0.93, R),

  // --- Travel ---
  rule("booking", "GLOBAL", ["BOOKING COM", "BOOKING"], "Booking.com", "travel", 0.94),
  rule("ryanair", "EU", ["RYANAIR"], "Ryanair", "travel", 0.97),
  rule("easyjet", "EU", ["EASYJET"], "easyJet", "travel", 0.96),
  rule("airbnb", "GLOBAL", ["AIRBNB"], "Airbnb", "travel", 0.96),
  rule("latam", "BR", ["LATAM"], "LATAM", "travel", 0.95),
  rule("ita-airways", "IT", ["ITA AIRWAYS"], "ITA Airways", "travel", 0.95),

  // --- Shopping & entertainment ---
  rule("apple-store", "GLOBAL", ["APPLE STORE"], "Apple", "shopping", 0.9),
  rule("amazon", "GLOBAL", ["AMAZON MKTPLACE", "AMAZON MARKETPLACE", "AMZN MKTP", "AMAZON", "AMZN"], "Amazon", "shopping", 0.9),
  rule("mercado-livre", "BR", ["MERCADOLIVRE", "MERCADO LIVRE", "MERCADOLIBRE"], "Mercado Livre", "shopping", 0.92),
  rule("shopee", "GLOBAL", ["SHOPEE"], "Shopee", "shopping", 0.93),
  rule("shein", "GLOBAL", ["SHEIN"], "Shein", "shopping", 0.93),
  rule("aliexpress", "GLOBAL", ["ALIEXPRESS"], "AliExpress", "shopping", 0.93),
  rule("magalu", "BR", ["MAGALU", "MAGAZINE LUIZA"], "Magalu", "shopping", 0.93),
  rule("zara", "GLOBAL", ["ZARA"], "Zara", "shopping", 0.94),
  rule("ikea", "GLOBAL", ["IKEA"], "IKEA", "shopping", 0.94),
  rule("decathlon", "GLOBAL", ["DECATHLON"], "Decathlon", "shopping", 0.94),
  rule("steam", "GLOBAL", ["STEAMGAMES", "STEAM"], "Steam", "entertainment", 0.93),
  rule("playstation", "GLOBAL", ["PLAYSTATION", "SONY INTERACTIVE"], "PlayStation", "entertainment", 0.93),
  rule("ticketone", "IT", ["TICKETONE"], "TicketOne", "entertainment", 0.93),
  rule("udemy", "GLOBAL", ["UDEMY"], "Udemy", "education", 0.94),
  rule("coursera", "GLOBAL", ["COURSERA"], "Coursera", "education", 0.94, R),
  rule("porto-seguro", "BR", ["PORTO SEGURO"], "Porto Seguro", "insurance", 0.93, R),
  rule("generali", "IT", ["ASSICURAZIONI GENERALI", "GENERALI"], "Generali", "insurance", 0.92, R),
  rule("unipol", "IT", ["UNIPOLSAI", "UNIPOL"], "UnipolSai", "insurance", 0.92, R),

  // --- Transfers & instant payments (generic wording: lowest priority) ---
  rule("own-account-transfer", "GLOBAL", ["GIROCONTO", "TRANSFERENCIA ENTRE CONTAS", "TRANSF ENTRE CONTAS", "ENTRE CONTAS", "TRANSFER BETWEEN ACCOUNTS", "OWN ACCOUNT"], null, "internal_transfer", 0.9, { transfer: true }),
  rule("card-payment", "GLOBAL", ["PAGAMENTO CARTA DI CREDITO", "PAGAMENTO CARTA", "CARD PAYMENT"], null, "card_payment", 0.8, { transfer: true }),
  rule("pix-received", "BR", ["PIX RECEBIDO", "RECEBIDA PELO PIX", "PIX RECEB"], null, null, 0.3),
  rule("transfer-received", "GLOBAL", ["TRANSFERENCIA RECEBIDA", "TED RECEBIDA", "BONIFICO A VOSTRO FAVORE", "BONIFICO RICEVUTO", "BONIFICO DA", "TRANSFER FROM", "RECEIVED TRANSFER"], null, "internal_transfer", 0.55, { transfer: true }),
  rule("transfer-sent", "GLOBAL", ["TRANSFERENCIA ENVIADA", "TRANSF ENVIADA", "TED ENVIADA", "BONIFICO A FAVORE", "BONIFICO DISPOSTO", "BONIFICO A", "TRANSFER TO", "SENT TRANSFER"], null, "internal_transfer", 0.6, { transfer: true }),
  rule("pix-generic", "BR", ["PIX ENVIADO", "PAGAMENTO PIX", "PIX"], null, null, 0.3),
  rule("transfer-generic", "GLOBAL", ["TRANSFERENCIA", "BONIFICO", "TRANSFER"], null, null, 0.4, { transfer: true }),
];

/** Words that mark money returned by a merchant (incoming → `refunds`). */
export const REFUND_MARKERS: readonly string[] = ["ESTORNO", "STORNO", "REFUND", "RIMBORSO", "REEMBOLSO", "CHARGEBACK", "DEVOLUCAO"];

export interface KeywordRule {
  category: CategorySlug;
  confidence: number;
  /** Single normalized tokens; any of them triggers the rule. */
  keywords: readonly string[];
}

/** Deterministic fallback when no fixture matched. Merchant stays null. */
export const KEYWORD_RULES: readonly KeywordRule[] = [
  { category: "groceries", confidence: 0.6, keywords: ["SUPERMERCADO", "SUPERMERCATO", "SUPERMARKET", "MERCADO", "MERCEARIA", "HORTIFRUTI", "ALIMENTARI"] },
  { category: "dining", confidence: 0.55, keywords: ["RESTAURANTE", "RISTORANTE", "PIZZARIA", "PIZZERIA", "LANCHONETE", "PADARIA", "TRATTORIA", "OSTERIA", "CAFE", "CAFFE", "BAR", "BURGER", "SUSHI"] },
  { category: "fuel", confidence: 0.6, keywords: ["POSTO", "DISTRIBUTORE", "CARBURANTE", "CARBURANTI", "COMBUSTIVEL", "GASOLINA"] },
  { category: "transport", confidence: 0.55, keywords: ["ESTACIONAMENTO", "PARCHEGGIO", "PARKING", "PEDAGIO", "TAXI", "METRO"] },
  { category: "travel", confidence: 0.55, keywords: ["HOTEL", "HOTELS", "POUSADA", "ALBERGO", "AIRLINES"] },
  { category: "health", confidence: 0.55, keywords: ["CLINICA", "HOSPITAL", "OSPEDALE", "LABORATORIO", "DENTISTA", "ODONTO", "ACADEMIA", "PALESTRA", "GYM"] },
  { category: "personal_care", confidence: 0.55, keywords: ["BARBEARIA", "SALAO", "PARRUCCHIERE", "ESTETICA"] },
  { category: "entertainment", confidence: 0.5, keywords: ["CINEMA", "TEATRO", "INGRESSO", "INGRESSOS"] },
  { category: "education", confidence: 0.55, keywords: ["ESCOLA", "SCUOLA", "UNIVERSIDADE", "UNIVERSITA", "FACULDADE", "CURSO"] },
  { category: "insurance", confidence: 0.6, keywords: ["SEGURO", "SEGUROS", "ASSICURAZIONE", "ASSICURAZIONI", "INSURANCE"] },
  { category: "subscriptions", confidence: 0.5, keywords: ["ASSINATURA", "ABBONAMENTO", "SUBSCRIPTION"] },
  { category: "telecom", confidence: 0.5, keywords: ["TELECOM", "INTERNET", "FIBRA", "CELULAR"] },
  { category: "shopping", confidence: 0.5, keywords: ["LOJA", "LOJAS", "NEGOZIO", "STORE", "SHOPPING"] },
];
