-- Monio core schema
--
-- Design notes
-- * Every user-owned row carries user_id (defaults to auth.uid()) and is protected by RLS.
-- * Child rows reference parents through composite foreign keys (id, user_id) so a row can
--   never point at another user's entity/account/document, even through the service role.
-- * Monetary values use NUMERIC (never float). Signed amounts: negative = money out.
-- * Original values are preserved; conversions are computed at read time, never stored over
--   the source amount.
-- * Global reference data (currencies, institution catalog, system categories, crypto asset
--   catalog, exchange rates) is readable by authenticated users and writable only by the
--   service role.

-- ---------------------------------------------------------------------------
-- Utilities
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table public.currencies (
  code text primary key check (code ~ '^[A-Z0-9]{2,10}$'),
  kind text not null check (kind in ('fiat', 'crypto', 'stablecoin')),
  name text not null,
  decimals smallint not null check (decimals between 0 and 18),
  display_decimals smallint not null check (display_decimals between 0 and 18),
  pegged_to text references public.currencies (code)
);

insert into public.currencies (code, kind, name, decimals, display_decimals, pegged_to) values
  ('EUR', 'fiat', 'Euro', 2, 2, null),
  ('BRL', 'fiat', 'Brazilian real', 2, 2, null),
  ('USD', 'fiat', 'US dollar', 2, 2, null),
  ('GBP', 'fiat', 'Pound sterling', 2, 2, null),
  ('CHF', 'fiat', 'Swiss franc', 2, 2, null),
  ('BTC', 'crypto', 'Bitcoin', 8, 6, null),
  ('ETH', 'crypto', 'Ether', 18, 5, null),
  ('POL', 'crypto', 'Polygon', 18, 4, null),
  ('WBTC', 'crypto', 'Wrapped Bitcoin', 8, 6, null),
  ('LINK', 'crypto', 'Chainlink', 18, 4, null),
  ('UNI', 'crypto', 'Uniswap', 18, 4, null),
  ('ARB', 'crypto', 'Arbitrum', 18, 4, null),
  ('OP', 'crypto', 'Optimism', 18, 4, null),
  ('USDC', 'stablecoin', 'USD Coin', 6, 2, 'USD'),
  ('USDT', 'stablecoin', 'Tether USD', 6, 2, 'USD'),
  ('DAI', 'stablecoin', 'Dai', 18, 2, 'USD'),
  ('EURC', 'stablecoin', 'Euro Coin', 6, 2, 'EUR');

create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  -- NULL owner = shared catalog entry; otherwise a user-defined institution.
  owner_id uuid references auth.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  country text check (country ~ '^[A-Z]{2}$'),
  kind text not null default 'bank'
    check (kind in ('bank', 'neobank', 'broker', 'exchange', 'wallet', 'card_issuer', 'other')),
  bic text,
  brand_color text check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);
create unique index institutions_catalog_slug on public.institutions (slug) where owner_id is null;
create unique index institutions_owner_slug on public.institutions (owner_id, slug) where owner_id is not null;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  -- NULL user = system category (labels translated by slug in the UI).
  user_id uuid references auth.users (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9_]{2,48}$'),
  kind text not null check (kind in ('expense', 'income', 'transfer')),
  name text check (name is null or char_length(name) <= 60),
  icon text,
  hue smallint check (hue between 0 and 360),
  created_at timestamptz not null default now()
);
create unique index categories_system_slug on public.categories (slug) where user_id is null;
create unique index categories_user_slug on public.categories (user_id, slug) where user_id is not null;

insert into public.categories (slug, kind, icon, hue) values
  ('groceries', 'expense', 'ShoppingBasket', 145),
  ('dining', 'expense', 'UtensilsCrossed', 40),
  ('transport', 'expense', 'TramFront', 230),
  ('fuel', 'expense', 'Fuel', 60),
  ('housing', 'expense', 'House', 265),
  ('utilities', 'expense', 'Zap', 85),
  ('telecom', 'expense', 'Wifi', 210),
  ('subscriptions', 'expense', 'Repeat', 300),
  ('shopping', 'expense', 'ShoppingBag', 335),
  ('health', 'expense', 'HeartPulse', 15),
  ('travel', 'expense', 'Plane', 195),
  ('entertainment', 'expense', 'Clapperboard', 320),
  ('education', 'expense', 'GraduationCap', 250),
  ('personal_care', 'expense', 'Sparkles', 350),
  ('insurance', 'expense', 'ShieldCheck', 180),
  ('taxes', 'expense', 'Landmark', 25),
  ('fees', 'expense', 'Receipt', 10),
  ('gifts_donations', 'expense', 'Gift', 355),
  ('business_expenses', 'expense', 'Briefcase', 205),
  ('cash_withdrawal', 'expense', 'Banknote', 120),
  ('other_expense', 'expense', 'CircleDashed', 260),
  ('salary', 'income', 'BadgeDollarSign', 155),
  ('business_income', 'income', 'Building2', 170),
  ('freelance', 'income', 'PenTool', 160),
  ('interest', 'income', 'Percent', 140),
  ('dividends', 'income', 'TrendingUp', 150),
  ('refunds', 'income', 'Undo2', 175),
  ('other_income', 'income', 'CirclePlus', 165),
  ('internal_transfer', 'transfer', 'ArrowLeftRight', 240),
  ('card_payment', 'transfer', 'CreditCard', 240),
  ('investment', 'transfer', 'ChartLine', 275),
  ('fx_exchange', 'transfer', 'Repeat2', 220);

create table public.crypto_assets (
  id uuid primary key default gen_random_uuid(),
  network text not null
    check (network in ('bitcoin', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'base')),
  symbol text not null check (char_length(symbol) between 1 and 16),
  name text not null,
  contract_address text check (contract_address is null or contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  decimals smallint not null check (decimals between 0 and 36),
  currency_code text references public.currencies (code),
  is_stablecoin boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index crypto_assets_native on public.crypto_assets (network) where contract_address is null;
create unique index crypto_assets_token on public.crypto_assets (network, lower(contract_address))
  where contract_address is not null;

create table public.exchange_rates (
  base text not null references public.currencies (code),
  quote text not null references public.currencies (code),
  as_of date not null,
  rate numeric(38, 18) not null check (rate > 0),
  source text not null check (char_length(source) between 1 and 40),
  fetched_at timestamptz not null default now(),
  primary key (base, quote, as_of, source),
  check (base <> quote)
);
create index exchange_rates_lookup on public.exchange_rates (base, quote, as_of desc);

-- ---------------------------------------------------------------------------
-- Users, entities, accounts
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  locale text not null default 'pt' check (locale in ('pt', 'en', 'it')),
  primary_currency text not null default 'EUR' references public.currencies (code),
  include_business_in_net_worth boolean not null default false,
  ai_cloud_consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.financial_entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('personal', 'business', 'shared')),
  country text check (country ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index financial_entities_user on public.financial_entities (user_id);
create trigger financial_entities_updated_at before update on public.financial_entities
  for each row execute function public.set_updated_at();

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entity_id uuid not null,
  institution_id uuid references public.institutions (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  type text not null check (type in (
    'checking', 'savings', 'credit_card', 'investment', 'loan', 'mortgage',
    'crypto_wallet', 'cash', 'other'
  )),
  currency text not null references public.currencies (code),
  country text check (country ~ '^[A-Z]{2}$'),
  -- Only the last characters of the identifier are stored, plus a hash for matching.
  account_mask text check (account_mask is null or char_length(account_mask) <= 8),
  external_ref_hash text check (external_ref_hash is null or external_ref_hash ~ '^[0-9a-f]{64}$'),
  -- Informational only. A credit limit is never counted as an asset.
  credit_limit numeric(20, 2) check (credit_limit is null or credit_limit >= 0),
  include_in_net_worth boolean not null default true,
  is_archived boolean not null default false,
  last_synced_at timestamptz,
  sync_source text check (sync_source in ('import', 'manual', 'blockchain', 'seed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (entity_id, user_id) references public.financial_entities (id, user_id) on delete cascade
);
create index accounts_user on public.accounts (user_id);
create index accounts_entity on public.accounts (entity_id);
create index accounts_institution on public.accounts (institution_id);
create unique index accounts_external_ref on public.accounts (user_id, external_ref_hash)
  where external_ref_hash is not null;
create trigger accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

create table public.liability_details (
  account_id uuid primary key,
  user_id uuid not null default auth.uid(),
  original_principal numeric(20, 2) check (original_principal is null or original_principal >= 0),
  interest_rate_apr numeric(7, 4) check (interest_rate_apr is null or interest_rate_apr >= 0),
  monthly_payment numeric(20, 2),
  started_on date,
  maturity_on date,
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Documents and imports
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  detected_format text check (detected_format in ('csv', 'ofx', 'xlsx', 'pdf')),
  detected_institution_id uuid references public.institutions (id) on delete set null,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'processed', 'failed', 'needs_review')),
  period_start date,
  period_end date,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  -- Idempotency: the same file uploaded twice maps to the same document.
  unique (user_id, sha256)
);
create index documents_user on public.documents (user_id, created_at desc);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'needs_review')),
  stage text not null default 'received',
  progress smallint not null default 0 check (progress between 0 and 100),
  attempt smallint not null default 1 check (attempt >= 1),
  stats jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text check (error_message is null or char_length(error_message) <= 500),
  ai_provider text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade
);
create index import_jobs_user on public.import_jobs (user_id, created_at desc);
create index import_jobs_queue on public.import_jobs (status, created_at) where status in ('queued', 'processing');

-- ---------------------------------------------------------------------------
-- Categorisation, recurring payments, transactions
-- ---------------------------------------------------------------------------
create table public.categorization_rules (
  id uuid primary key default gen_random_uuid(),
  -- NULL user = system rule.
  user_id uuid references auth.users (id) on delete cascade,
  match_type text not null check (match_type in ('contains', 'starts_with', 'exact')),
  pattern text not null check (char_length(pattern) between 2 and 120),
  merchant text check (merchant is null or char_length(merchant) <= 80),
  category_id uuid not null references public.categories (id) on delete cascade,
  direction text check (direction in ('in', 'out')),
  priority integer not null default 100,
  source text not null check (source in ('system', 'user', 'ai', 'inbox')),
  hits integer not null default 0,
  last_hit_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index categorization_rules_unique
  on public.categorization_rules (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), match_type, pattern, coalesce(direction, '*'));

create table public.recurring_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id uuid,
  merchant text not null check (char_length(merchant) between 1 and 80),
  category_id uuid references public.categories (id) on delete set null,
  cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  average_amount numeric(38, 18) not null,
  last_amount numeric(38, 18) not null,
  currency text not null references public.currencies (code),
  first_seen_on date not null,
  last_seen_on date not null,
  next_expected_on date,
  occurrences integer not null check (occurrences >= 2),
  is_subscription boolean not null default false,
  status text not null default 'candidate' check (status in ('candidate', 'confirmed', 'dismissed')),
  detection_confidence numeric(4, 3) check (detection_confidence between 0 and 1),
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, fingerprint),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);
create index recurring_series_user on public.recurring_series (user_id, next_expected_on);
create trigger recurring_series_updated_at before update on public.recurring_series
  for each row execute function public.set_updated_at();

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id uuid not null,
  booked_on date not null,
  value_on date,
  description_original text not null check (char_length(description_original) between 1 and 500),
  description_clean text,
  merchant text check (merchant is null or char_length(merchant) <= 80),
  amount numeric(38, 18) not null check (amount <> 0),
  currency text not null references public.currencies (code),
  original_amount numeric(38, 18),
  original_currency text references public.currencies (code),
  fx_rate numeric(38, 18) check (fx_rate is null or fx_rate > 0),
  status text not null default 'posted' check (status in ('posted', 'pending')),
  classification text not null default 'regular' check (classification in (
    'regular', 'internal_transfer', 'card_payment', 'investment_transfer', 'fx_exchange'
  )),
  category_id uuid references public.categories (id) on delete set null,
  category_source text check (category_source in ('rule', 'ai', 'user', 'import', 'default')),
  category_confidence numeric(4, 3) check (category_confidence between 0 and 1),
  transfer_group_id uuid,
  counterpart_transaction_id uuid,
  duplicate_of uuid,
  recurring_series_id uuid,
  -- Deterministic hash used for idempotent (re)imports.
  fingerprint text not null check (char_length(fingerprint) between 8 and 128),
  external_id text,
  document_id uuid,
  import_job_id uuid,
  source_row integer,
  source text not null check (source in ('import', 'manual', 'seed', 'blockchain')),
  extraction text check (extraction in ('exact', 'heuristic', 'ai')),
  raw jsonb,
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (account_id, fingerprint),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete set null (document_id),
  foreign key (import_job_id, user_id) references public.import_jobs (id, user_id) on delete set null (import_job_id),
  foreign key (counterpart_transaction_id, user_id) references public.transactions (id, user_id) on delete set null (counterpart_transaction_id),
  foreign key (duplicate_of, user_id) references public.transactions (id, user_id) on delete set null (duplicate_of),
  foreign key (recurring_series_id, user_id) references public.recurring_series (id, user_id) on delete set null (recurring_series_id),
  check ((original_amount is null) = (original_currency is null))
);
create index transactions_user_date on public.transactions (user_id, booked_on desc);
create index transactions_account_date on public.transactions (account_id, booked_on desc);
create index transactions_category on public.transactions (user_id, category_id);
create index transactions_transfer_group on public.transactions (transfer_group_id) where transfer_group_id is not null;
create index transactions_recurring on public.transactions (recurring_series_id) where recurring_series_id is not null;
create index transactions_document on public.transactions (document_id) where document_id is not null;
create trigger transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

create table public.account_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  account_id uuid not null,
  as_of date not null,
  -- Signed: liabilities (card debt, loans) are negative.
  balance numeric(38, 18) not null,
  currency text not null references public.currencies (code),
  source text not null check (source in ('import', 'manual', 'blockchain', 'computed', 'seed')),
  document_id uuid,
  created_at timestamptz not null default now(),
  unique (account_id, as_of, source),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete set null (document_id)
);
create index account_balances_account_date on public.account_balances (account_id, as_of desc);
create index account_balances_user on public.account_balances (user_id, as_of desc);

-- ---------------------------------------------------------------------------
-- Crypto (watch-only)
-- ---------------------------------------------------------------------------
create table public.crypto_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  account_id uuid not null,
  family text not null check (family in ('bitcoin', 'evm')),
  networks text[] not null default '{}',
  watch_kind text not null check (watch_kind in ('address', 'xpub', 'descriptor')),
  -- Public identifier only (address / extended PUBLIC key). Private material is rejected upstream.
  public_identifier text not null check (char_length(public_identifier) between 20 and 512),
  label text check (label is null or char_length(label) <= 80),
  sync_status text not null default 'pending' check (sync_status in ('pending', 'ok', 'error', 'unsupported')),
  sync_error text check (sync_error is null or char_length(sync_error) <= 300),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, family, public_identifier),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  check (public_identifier !~* '^(xprv|yprv|zprv|tprv|uprv|vprv)')
);
create index crypto_wallets_user on public.crypto_wallets (user_id);

create table public.wallet_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  wallet_id uuid not null,
  asset_id uuid not null references public.crypto_assets (id),
  as_of date not null,
  quantity numeric(38, 18) not null check (quantity >= 0),
  created_at timestamptz not null default now(),
  unique (wallet_id, asset_id, as_of),
  foreign key (wallet_id, user_id) references public.crypto_wallets (id, user_id) on delete cascade
);
create index wallet_holdings_wallet on public.wallet_holdings (wallet_id, as_of desc);

create table public.blockchain_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  wallet_id uuid not null,
  asset_id uuid not null references public.crypto_assets (id),
  network text not null,
  tx_hash text not null check (char_length(tx_hash) between 10 and 100),
  log_index integer not null default -1,
  block_time timestamptz not null,
  direction text not null check (direction in ('in', 'out', 'self')),
  quantity numeric(38, 18) not null check (quantity >= 0),
  fee_quantity numeric(38, 18) check (fee_quantity is null or fee_quantity >= 0),
  counterparty text,
  classification text not null default 'unknown'
    check (classification in ('transfer_in', 'transfer_out', 'internal', 'unknown')),
  created_at timestamptz not null default now(),
  unique (wallet_id, network, tx_hash, log_index, asset_id),
  foreign key (wallet_id, user_id) references public.crypto_wallets (id, user_id) on delete cascade
);
create index blockchain_transactions_wallet on public.blockchain_transactions (wallet_id, block_time desc);

-- ---------------------------------------------------------------------------
-- Smart Inbox, insights, audit
-- ---------------------------------------------------------------------------
create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in (
    'transfer_match', 'possible_duplicate', 'unknown_institution', 'uncategorized',
    'subscription_candidate', 'stale_source', 'document_incomplete', 'account_confirmation'
  )),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  priority smallint not null default 50 check (priority between 0 and 100),
  dedupe_key text not null check (char_length(dedupe_key) between 3 and 200),
  payload jsonb not null default '{}'::jsonb,
  transaction_ids uuid[] not null default '{}',
  account_id uuid,
  document_id uuid,
  recurring_series_id uuid,
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, dedupe_key),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade,
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade,
  foreign key (recurring_series_id, user_id) references public.recurring_series (id, user_id) on delete cascade
);
create index inbox_items_open on public.inbox_items (user_id, status, priority desc, created_at desc);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  severity text not null default 'info' check (severity in ('info', 'positive', 'warning')),
  period_start date,
  period_end date,
  -- Values interpolated into the translated message.
  params jsonb not null default '{}'::jsonb,
  -- Aggregates and record ids the insight was derived from (traceability).
  evidence jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  generated_at timestamptz not null default now(),
  dismissed_at timestamptz,
  unique (user_id, fingerprint)
);
create index insights_user on public.insights (user_id, generated_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  actor text not null check (actor in ('user', 'system', 'worker', 'ai')),
  action text not null check (char_length(action) between 2 and 80),
  target_table text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_user on public.audit_log (user_id, created_at desc);
