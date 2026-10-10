import { getCategory, type CategorySlug } from "../categories/catalog";
import { normalizeDescription } from "../transactions/normalize";

/**
 * Deterministic category recognition from the description alone, in four tiers:
 *
 * 1. the stated purpose of the movement (salary, card bill, rent, tax, refund...);
 * 2. a known merchant;
 * 3. a word that names a kind of business or bill (pharmacy, supermarket, subscription);
 * 4. an everyday word that also names a bill but is ambiguous on its own
 *    (energy, internet, market, store).
 *
 * Tier 4 is skipped when the movement is worded as a transfer: "PIX enviado -
 * Maria Luz" is money sent to a person, not an electricity bill. A transfer to
 * a person or company says nothing about what it paid for, so it is never
 * categorized from the wording of the transfer itself.
 *
 * Patterns are whole words (accents and case ignored), in Portuguese, Italian,
 * English, Spanish and German. Listing a plural or a variant is explicit on
 * purpose: prefixes are not matched, so TIMOTEO is not TIM.
 */

// Specific payment purposes precede merchant names. Never infer ownership from PIX/TED/bonifico alone.
const PURPOSES: readonly [CategorySlug, string][] = [
  ["card_payment", "PAGAMENTO DE FATURA|PAGAMENTO FATURA|PAGTO FATURA|PGTO FATURA|FATURA CARTAO|CREDIT CARD PAYMENT|SALDO CARTA DI CREDITO|PAGAMENTO CARTA DI CREDITO|ESTRATTO CONTO CARTA|KREDITKARTENABRECHNUNG"],
  ["investment", "APLICACAO CDB|APLICACAO RDB|APLICACAO FINANCEIRA|APLICACAO EM FUNDO|APLICACAO FUNDO|RESGATE CDB|RESGATE RDB|RESGATE DE INVESTIMENTO|RESGATE FUNDO|TESOURO DIRETO|COMPRA DE ACOES|VENDA DE ACOES|ACQUISTO TITOLI|VENDITA TITOLI|RISCATTO FONDI|SOTTOSCRIZIONE FONDI|FONDO PENSIONE|PREVIDENCIA PRIVADA|BROKERAGE TRANSFER|WERTPAPIERKAUF"],
  ["fx_exchange", "EXCHANGED TO|EXCHANGED FROM|CURRENCY EXCHANGE|FX EXCHANGE|CONVERSAO DE MOEDA|CAMBIO VALUTA|COMPRA DE MOEDA"],
  ["refunds", "ESTORNO|REEMBOLSO|REEMBOLSOS|RIMBORSO|RIMBORSI|REFUND|REFUNDS|CASHBACK|DEVOLUCAO|STORNO|CHARGEBACK|REVERSAL|RESTITUZIONE|ERSTATTUNG|REMBOURSEMENT"],
  ["salary", "SALARIO|SALARIOS|STIPENDIO|STIPENDI|EMOLUMENTI|PAYROLL|SALARY|WAGES|FOLHA DE PAGAMENTO|PRO LABORE|PROLABORE|DECIMO TERCEIRO|TREDICESIMA|NOMINA|GEHALT|LOHN|SALAIRE"],
  ["dividends", "DIVIDENDOS|DIVIDENDO|DIVIDENDI|DIVIDENDS|DIVIDEND|JCP|JUROS SOBRE CAPITAL|CEDOLA|CEDOLE"],
  ["interest", "RENDIMENTO|RENDIMENTOS|REMUNERACAO|INTERESSI ATTIVI|INTERESSI CREDITORI|INTEREST CREDIT|INTEREST PAID|INTEREST EARNED|JUROS CREDITADOS|HABENZINSEN"],
  ["loan_payment", "PARCELA EMPRESTIMO|PARCELA DE EMPRESTIMO|PARCELA FINANCIAMENTO|FINANCIAMENTO|EMPRESTIMO|CONSORCIO|RATA MUTUO|RATA PRESTITO|RATA FINANZIAMENTO|MUTUO|PRESTITO|LOAN PAYMENT|LOAN REPAYMENT|MORTGAGE PAYMENT|MORTGAGE|LEASING|KREDITRATE|TILGUNG"],
  ["taxes", "IRRF|IRPF|DARF|IPTU|IPVA|INSS|ICMS|DAS SIMPLES NACIONAL|SIMPLES NACIONAL|RECEITA FEDERAL|IMPOSTO|IMPOSTOS|TRIBUTO|TRIBUTOS|LICENCIAMENTO|IMPOSTA DI BOLLO|IMPOSTA|IMPOSTE|TASSA|TASSE|AGENZIA DELLE ENTRATE|F24|IMU|TARI|BOLLO AUTO|CANONE RAI|INCOME TAX|COUNCIL TAX|HMRC|TAX PAYMENT|FINANZAMT|STEUER|IMPUESTO|IMPUESTOS"],
  ["fees", "TARIFA|TARIFAS|IOF|JUROS DE MORA|JUROS ROTATIVO|ENCARGOS|ANUIDADE|MANUTENCAO DE CONTA|TAXA DE MANUTENCAO|COMMISSIONE|COMMISSIONI|INTERESSI PASSIVI|CANONE CONTO|CANONE MENSILE|SPESE TENUTA CONTO|SPESE DI GESTIONE|ACCOUNT FEE|MONTHLY FEE|SERVICE CHARGE|BANK FEE|BANK CHARGES|OVERDRAFT FEE|KONTOFUHRUNG|KONTOFUHRUNGSGEBUHR|COMISION|COMISIONES"],
  ["cash_withdrawal", "SAQUE|SAQUES|PRELIEVO|PRELIEVI|PRELEVAMENTO|CASH WITHDRAWAL|ATM WITHDRAWAL|BANCOMAT|BANCO24HORAS|BANCO 24 HORAS|BARGELDAUSZAHLUNG|RETRAIT|RETIRO EFECTIVO"],
  ["housing", "ALUGUEL|ALUGUEIS|AFFITTO|AFFITTI|CANONE DI LOCAZIONE|LOCAZIONE|CONDOMINIO|SPESE CONDOMINIALI|RENT PAYMENT|RENT|MIETE|LOYER|ALQUILER"],
  ["gifts_donations", "DOACAO|DOACOES|DIZIMO|DONAZIONE|DONAZIONI|BENEFICENZA|DONATION|DONATIONS|CHARITY|SPENDE"],
];

const MERCHANTS: readonly [CategorySlug, string, string][] = [
  ["subscriptions", "Netflix", "NETFLIX"], ["subscriptions", "Spotify", "SPOTIFY"],
  ["subscriptions", "Amazon Prime", "AMAZON PRIME|AMZN PRIME|PRIME VIDEO"],
  ["subscriptions", "Apple", "APPLE.COM/BILL|APPLE COM BILL|ITUNES|ICLOUD"],
  ["subscriptions", "Google", "YOUTUBE PREMIUM|GOOGLE ONE|GOOGLE WORKSPACE"],
  ["subscriptions", "OpenAI", "OPENAI|CHATGPT"], ["subscriptions", "Adobe", "ADOBE"],
  ["subscriptions", "Disney+", "DISNEYPLUS|DISNEY PLUS"], ["subscriptions", "HBO Max", "HBO MAX|HBOMAX"],
  ["subscriptions", "Globoplay", "GLOBOPLAY"], ["subscriptions", "Deezer", "DEEZER"], ["subscriptions", "DAZN", "DAZN"],
  ["subscriptions", "Microsoft", "MICROSOFT 365|OFFICE 365"], ["subscriptions", "Dropbox", "DROPBOX"], ["subscriptions", "GitHub", "GITHUB"],
  ["transport", "Uber", "UBER"], ["transport", "99", "99APP|99 POP|99POP"], ["transport", "Cabify", "CABIFY"],
  ["transport", "Trenitalia", "TRENITALIA"], ["transport", "Italo", "ITALO TRENO|ITALOTRENO|NTV ITALO"], ["transport", "Trenord", "TRENORD"],
  ["transport", "Telepass", "TELEPASS"], ["transport", "Sem Parar", "SEM PARAR|SEMPARAR"], ["transport", "ConectCar", "CONECTCAR"],
  ["transport", "FlixBus", "FLIXBUS"], ["transport", "BlaBlaCar", "BLABLACAR"], ["transport", "Lyft", "LYFT"],
  ["dining", "Uber Eats", "UBER EATS|UBER *EATS|UBER*EATS"],
  ["dining", "iFood", "IFOOD|IFD"], ["dining", "Rappi", "RAPPI"], ["dining", "Deliveroo", "DELIVEROO"], ["dining", "Glovo", "GLOVO"], ["dining", "Just Eat", "JUST EAT|JUSTEAT"],
  ["dining", "McDonald's", "MCDONALDS|MC DONALDS"], ["dining", "Burger King", "BURGER KING"], ["dining", "Starbucks", "STARBUCKS"],
  ["groceries", "Esselunga", "ESSELUNGA"], ["groceries", "Lidl", "LIDL"], ["groceries", "Aldi", "ALDI"],
  ["groceries", "Carrefour", "CARREFOUR"], ["groceries", "Conad", "CONAD"], ["groceries", "Coop", "COOP"],
  ["groceries", "Eurospin", "EUROSPIN"], ["groceries", "Assaí", "ASSAI"], ["groceries", "Pão de Açúcar", "PAO DE ACUCAR"],
  ["groceries", "Atacadão", "ATACADAO"], ["groceries", "Tesco", "TESCO"], ["groceries", "Mercadona", "MERCADONA"],
  ["shopping", "Amazon", "AMAZON|AMZN"], ["shopping", "Mercado Livre", "MERCADO LIVRE|MERCADOLIVRE"],
  ["shopping", "Shopee", "SHOPEE"], ["shopping", "IKEA", "IKEA"], ["shopping", "Zara", "ZARA"], ["shopping", "AliExpress", "ALIEXPRESS"],
  ["shopping", "Magazine Luiza", "MAGAZINE LUIZA|MAGALU"], ["shopping", "Decathlon", "DECATHLON"], ["shopping", "Leroy Merlin", "LEROY MERLIN"],
  ["telecom", "TIM", "TIM"], ["telecom", "Vodafone", "VODAFONE"], ["telecom", "Claro", "CLARO"], ["telecom", "Vivo", "VIVO"],
  ["telecom", "Fastweb", "FASTWEB"], ["telecom", "Iliad", "ILIAD"], ["telecom", "WindTre", "WINDTRE|WIND TRE"], ["telecom", "Telecom Italia", "TELECOM ITALIA"],
  ["utilities", "Enel", "ENEL"], ["utilities", "Sabesp", "SABESP"], ["utilities", "A2A", "A2A"], ["utilities", "CPFL", "CPFL"],
  ["utilities", "Cemig", "CEMIG"], ["utilities", "Copel", "COPEL"], ["utilities", "Comgás", "COMGAS"], ["utilities", "Hera", "HERA COMM"], ["utilities", "Iren", "IREN"],
  ["fuel", "Shell", "SHELL"], ["fuel", "Ipiranga", "IPIRANGA"], ["fuel", "Petrobras", "PETROBRAS"], ["fuel", "Eni", "ENI STATION|AGIP"], ["fuel", "Q8", "Q8"], ["fuel", "Esso", "ESSO"],
  ["health", "Drogasil", "DROGASIL"], ["health", "Droga Raia", "DROGA RAIA"], ["health", "Unimed", "UNIMED"],
  ["travel", "Airbnb", "AIRBNB"], ["travel", "Booking.com", "BOOKING.COM|BOOKING COM"], ["travel", "Ryanair", "RYANAIR"],
  ["travel", "easyJet", "EASYJET"], ["travel", "LATAM", "LATAM"], ["travel", "Lufthansa", "LUFTHANSA"], ["travel", "Expedia", "EXPEDIA"], ["travel", "Decolar", "DECOLAR"],
  ["entertainment", "Steam", "STEAM GAMES|STEAMGAMES|STEAM PURCHASE"], ["entertainment", "PlayStation", "PLAYSTATION"], ["entertainment", "Xbox", "XBOX"],
  ["entertainment", "Nintendo", "NINTENDO"], ["entertainment", "Ticketmaster", "TICKETMASTER"],
  ["education", "Udemy", "UDEMY"], ["education", "Coursera", "COURSERA"], ["education", "Duolingo", "DUOLINGO"],
];

/** Words that name a kind of business or bill whatever surrounds them. */
const KEYWORDS: readonly [CategorySlug, string][] = [
  ["groceries", "SUPERMERCADO|SUPERMERCADOS|SUPERMERCATO|SUPERMERCATI|SUPERMARKET|HIPERMERCADO|IPERMERCATO|MINIMERCADO|MERCEARIA|HORTIFRUTI|SACOLAO|QUITANDA|ACOUGUE|MACELLERIA|ALIMENTARI|GROCERY|GROCERIES|ATACADISTA|LEBENSMITTEL|SUPERMARCHE"],
  ["dining", "RESTAURANTE|RESTAURANTES|RISTORANTE|TRATTORIA|OSTERIA|PIZZARIA|PIZZERIA|LANCHONETE|PADARIA|PASTICCERIA|PANETTERIA|BAKERY|RESTAURANT|HAMBURGUERIA|CHURRASCARIA|GELATERIA|SORVETERIA|CAFETERIA|CAFETARIA|CONFEITARIA|STEAKHOUSE|FAST FOOD|TAVOLA CALDA|ROSTICCERIA|GASTSTATTE"],
  ["health", "FARMACIA|FARMACIAS|PARAFARMACIA|DROGARIA|DROGARIAS|PHARMACY|APOTHEKE|HOSPITAL|OSPEDALE|DENTISTA|DENTIST|CLINICA|LABORATORIO|PLANO DE SAUDE|CONSULTA MEDICA|STUDIO MEDICO|ANALISI CLINICHE|FISIOTERAPIA|OTICA|OTTICA|OPTICIAN|ACADEMIA|PALESTRA|GYM|FITNESS"],
  ["fuel", "POSTO DE COMBUSTIVEL|POSTO DE GASOLINA|POSTO|COMBUSTIVEL|COMBUSTIVEIS|GASOLINA|ETANOL|CARBURANTE|CARBURANTI|BENZINA|DISTRIBUTORE|PETROL STATION|GAS STATION|FUEL|TANKSTELLE|GASOLINERA"],
  ["transport", "ESTACIONAMENTO|PARCHEGGIO|PARKING|PEDAGIO|PEDAGGIO|TOLL|TAXI|METRO|METROPOLITANA|ONIBUS|AUTOBUS|BILHETE UNICO|TRASPORTI|TRASPORTO PUBBLICO|TRANSPORTE PUBLICO|PUBLIC TRANSPORT|TRAIN TICKET|BIGLIETTO TRENO|PASSAGEM RODOVIARIA"],
  ["utilities", "ENERGIA ELETRICA|ENERGIA ELETTRICA|CONTA DE LUZ|CONTA DE AGUA|CONTA DE GAS|CONTA DE ENERGIA|BOLLETTA|BOLLETTE|BOLLETTA GAS|BOLLETTA LUCE|LUCE E GAS|ELETTRICITA|ELETRICIDADE|SANEAMENTO|WATER BILL|GAS BILL|ELECTRICITY|ELECTRIC BILL|UTILITIES|UTILITY BILL|STROM|STADTWERKE"],
  ["telecom", "TELEFONIA|TELEFONE|TELEFONO|CELULAR|CELLULARE|BANDA LARGA|FIBRA OTICA|FIBRA OTTICA|TELECOM|TELECOMUNICACOES|TELECOMUNICAZIONI|BROADBAND|PHONE BILL|MOBILE PLAN|RICARICA TELEFONICA|RECARGA CELULAR|RECARGA DE CELULAR|MOBILFUNK"],
  ["subscriptions", "ASSINATURA|ASSINATURAS|ABBONAMENTO|ABBONAMENTI|SUBSCRIPTION|SUBSCRIPTIONS|STREAMING|MEMBERSHIP|SUSCRIPCION|ABONNEMENT"],
  ["education", "ESCOLA|COLEGIO|FACULDADE|UNIVERSIDADE|UNIVERSITA|SCUOLA|SCHOOL|UNIVERSITY|TUITION|MENSALIDADE ESCOLAR|RETTA SCOLASTICA|MATERIAL ESCOLAR"],
  ["personal_care", "BARBEARIA|CABELEIREIRO|PARRUCCHIERE|BARBIERE|BARBER|SALAO DE BELEZA|ESTETICA|ESTETISTA|MANICURE|PERFUMARIA|PROFUMERIA|COSMETICOS|HAIRDRESSER|FRISEUR"],
  ["insurance", "SEGURO|SEGUROS|SEGURADORA|ASSICURAZIONE|ASSICURAZIONI|POLIZZA|APOLICE|INSURANCE|VERSICHERUNG"],
  ["travel", "HOTEL|HOTEIS|POUSADA|ALBERGO|HOSTEL|RESORT|PASSAGEM AEREA|PASSAGENS AEREAS|BIGLIETTO AEREO|AIRLINE|AIRLINES|FLIGHT|AGENCIA DE VIAGENS|AGENZIA VIAGGI"],
  ["entertainment", "CINEMA|TEATRO|THEATER|THEATRE|MUSEU|MUSEO|INGRESSO|INGRESSOS|BIGLIETTERIA|CONCERTO|CONCERT"],
];

/** Everyday words that name a bill or a kind of shop, unless the movement is a transfer to someone. */
const EVERYDAY: readonly [CategorySlug, string][] = [
  ["utilities", "ENERGIA|LUZ|LUCE|AGUA|ACQUA|GAS|ENERGY|WATER"],
  ["telecom", "INTERNET|WIFI"],
  ["groceries", "MERCADO|MERCADINHO|MERCATO|MARKET|FEIRA"],
  ["dining", "BAR|CAFE|CAFFE|COFFEE|PIZZA|BURGER|SUSHI|PUB|LANCHES|LANCHE"],
  ["transport", "TRANSPORTE|TRANSPORTES|TRASPORTO|TRANSPORT|PASSAGEM|BUS|TREM|TRENO"],
  ["fees", "CANONE|TAXA|TAXAS|JUROS|COMMISSION|FEE|FEES|GEBUHR"],
  ["shopping", "LOJA|LOJAS|NEGOZIO|STORE|SHOP|SHOPPING|ABBIGLIAMENTO|VESTUARIO|ROUPAS|CALCADOS|CALZATURE|ELETRONICOS|ELETTRONICA|MOVEIS|ACQUISTO ONLINE|COMPRA ONLINE"],
];

/** Phrases in which an everyday or business word means something else. */
const MISLEADING = "INTERNET BANKING|INTERNET BANK|VIA INTERNET|PELA INTERNET|COMPRA INTERNET|ACQUISTO INTERNET|HOME BANKING|MERCADO PAGO|MERCADOPAGO|MERCADO BITCOIN|MERCADO LIVRE|PAG SEGURO|PAGAMENTO SEGURO|SITE SEGURO|APP STORE|PLAY STORE|GOOGLE STORE";

/** Wording of money sent to or received from someone: it does not say what it was for. */
const TRANSFER_WORDING = "PIX|TED|DOC|TRANSFERENCIA|TRANSFERENCIAS|TRANSF|BONIFICO|BONIFICI|GIROCONTO|TRANSFER|WIRE|ZELLE|UBERWEISUNG|VIREMENT";

function tokens(text: string): string {
  return normalizeDescription(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const compile = (patterns: string) => patterns.split("|").map((p) => ` ${tokens(p)} `);
const hits = (padded: string, compiled: readonly string[]) => compiled.some((p) => padded.includes(p));

const PURPOSE_PATTERNS = PURPOSES.map(([slug, patterns]) => ({ slug, patterns: compile(patterns) }));
// Longest merchant alias wins (Uber Eats before Uber, Amazon Prime before Amazon).
const MERCHANT_PATTERNS = MERCHANTS.flatMap(([slug, merchant, aliases]) => compile(aliases).map((alias) => ({ slug, merchant, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);
const KEYWORD_PATTERNS = KEYWORDS.map(([slug, patterns]) => ({ slug, patterns: compile(patterns) }));
const EVERYDAY_PATTERNS = EVERYDAY.map(([slug, patterns]) => ({ slug, patterns: compile(patterns) }));
const MISLEADING_PATTERNS = compile(MISLEADING);
const TRANSFER_PATTERNS = compile(TRANSFER_WORDING);

/** Conservative defaults available even when AI is disabled or fails. */
export function recognizeCategory(description: string, amount: string): {
  categorySlug: CategorySlug; merchant: string | null; confidence: number;
} | null {
  const padded = ` ${tokens(description)} `;
  const incoming = !amount.trim().startsWith("-");
  const eligible = (slug: CategorySlug) => {
    const kind = getCategory(slug)!.kind;
    return kind === "transfer" || kind === (incoming ? "income" : "expense");
  };
  for (const { slug, patterns } of PURPOSE_PATTERNS) {
    if (!hits(padded, patterns)) continue;
    // An explicit purpose with incompatible direction must not fall through to a merchant.
    if (!eligible(slug)) return null;
    return { categorySlug: slug, merchant: null, confidence: 0.9 };
  }
  for (const { slug, merchant, alias } of MERCHANT_PATTERNS) {
    if (padded.includes(alias) && eligible(slug)) return { categorySlug: slug, merchant, confidence: 0.92 };
  }
  // Words below describe what was bought: a phrase that gives them another meaning hides them.
  const plain = MISLEADING_PATTERNS.reduce((text, phrase) => text.split(phrase).join("  "), padded);
  for (const { slug, patterns } of KEYWORD_PATTERNS) {
    if (eligible(slug) && hits(plain, patterns)) return { categorySlug: slug, merchant: null, confidence: 0.85 };
  }
  if (hits(padded, TRANSFER_PATTERNS)) return null;
  for (const { slug, patterns } of EVERYDAY_PATTERNS) {
    if (eligible(slug) && hits(plain, patterns)) return { categorySlug: slug, merchant: null, confidence: 0.8 };
  }
  return null;
}
