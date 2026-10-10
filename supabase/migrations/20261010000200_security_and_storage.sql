-- Row Level Security, bootstrap triggers, audit trail, storage and helper views.

-- ---------------------------------------------------------------------------
-- New user bootstrap: profile + default personal entity
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_locale text := new.raw_user_meta_data ->> 'locale';
  requested_currency text := new.raw_user_meta_data ->> 'primary_currency';
begin
  insert into public.profiles (id, display_name, locale, primary_currency)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)), 80),
    case when requested_locale in ('pt', 'en', 'it') then requested_locale else 'pt' end,
    case when requested_currency in ('EUR', 'BRL', 'USD', 'BTC', 'ETH') then requested_currency else 'EUR' end
  );
  insert into public.financial_entities (user_id, name, kind)
  values (new.id, 'Personal', 'personal');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Audit trail (append-only for users)
-- ---------------------------------------------------------------------------
create or replace function public.audit_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.category_id is distinct from old.category_id then
      changes := changes || jsonb_build_object('category_id', jsonb_build_array(old.category_id, new.category_id));
    end if;
    if new.classification is distinct from old.classification then
      changes := changes || jsonb_build_object('classification', jsonb_build_array(old.classification, new.classification));
    end if;
    if new.amount is distinct from old.amount then
      changes := changes || jsonb_build_object('amount', jsonb_build_array(old.amount::text, new.amount::text));
    end if;
    if new.booked_on is distinct from old.booked_on then
      changes := changes || jsonb_build_object('booked_on', jsonb_build_array(old.booked_on, new.booked_on));
    end if;
    if new.duplicate_of is distinct from old.duplicate_of then
      changes := changes || jsonb_build_object('duplicate_of', jsonb_build_array(old.duplicate_of, new.duplicate_of));
    end if;
    if changes = '{}'::jsonb then
      return new;
    end if;
    insert into public.audit_log (user_id, actor, action, target_table, target_id, details)
    values (new.user_id, case when auth.uid() is null then 'system' else 'user' end,
            'transaction.updated', 'transactions', new.id, changes);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (user_id, actor, action, target_table, target_id, details)
    values (old.user_id, case when auth.uid() is null then 'system' else 'user' end,
            'transaction.deleted', 'transactions', old.id,
            jsonb_build_object('amount', old.amount::text, 'currency', old.currency, 'booked_on', old.booked_on));
    return old;
  end if;
  return null;
end;
$$;

create trigger transactions_audit_update
  after update on public.transactions
  for each row execute function public.audit_transaction_change();
create trigger transactions_audit_delete
  after delete on public.transactions
  for each row execute function public.audit_transaction_change();

-- Lets authenticated users append audit records for their own actions only.
create or replace function public.log_user_action(p_action text, p_target_table text, p_target_id uuid, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.audit_log (user_id, actor, action, target_table, target_id, details)
  values (auth.uid(), 'user', left(p_action, 80), p_target_table, p_target_id, coalesce(p_details, '{}'::jsonb));
end;
$$;
revoke all on function public.log_user_action(text, text, uuid, jsonb) from public, anon;
grant execute on function public.log_user_action(text, text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.currencies enable row level security;
alter table public.institutions enable row level security;
alter table public.categories enable row level security;
alter table public.crypto_assets enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.profiles enable row level security;
alter table public.financial_entities enable row level security;
alter table public.accounts enable row level security;
alter table public.liability_details enable row level security;
alter table public.documents enable row level security;
alter table public.import_jobs enable row level security;
alter table public.categorization_rules enable row level security;
alter table public.recurring_series enable row level security;
alter table public.transactions enable row level security;
alter table public.account_balances enable row level security;
alter table public.crypto_wallets enable row level security;
alter table public.wallet_holdings enable row level security;
alter table public.blockchain_transactions enable row level security;
alter table public.inbox_items enable row level security;
alter table public.insights enable row level security;
alter table public.audit_log enable row level security;

-- Reference data: read-only for signed-in users.
create policy "currencies are readable" on public.currencies
  for select to authenticated using (true);
create policy "crypto assets are readable" on public.crypto_assets
  for select to authenticated using (true);
create policy "exchange rates are readable" on public.exchange_rates
  for select to authenticated using (true);

-- Catalog + user-owned rows.
create policy "institutions: read catalog and own" on public.institutions
  for select to authenticated using (owner_id is null or owner_id = (select auth.uid()));
create policy "institutions: insert own" on public.institutions
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "institutions: update own" on public.institutions
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "institutions: delete own" on public.institutions
  for delete to authenticated using (owner_id = (select auth.uid()));

create policy "categories: read system and own" on public.categories
  for select to authenticated using (user_id is null or user_id = (select auth.uid()));
create policy "categories: insert own" on public.categories
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "categories: update own" on public.categories
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "categories: delete own" on public.categories
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "rules: read system and own" on public.categorization_rules
  for select to authenticated using (user_id is null or user_id = (select auth.uid()));
create policy "rules: insert own" on public.categorization_rules
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "rules: update own" on public.categorization_rules
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "rules: delete own" on public.categorization_rules
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Fully user-owned tables: one policy per command keeps intent explicit.
do $$
declare
  t text;
begin
  foreach t in array array[
    'financial_entities', 'accounts', 'liability_details', 'documents', 'import_jobs',
    'recurring_series', 'transactions', 'account_balances', 'crypto_wallets',
    'wallet_holdings', 'blockchain_transactions', 'inbox_items', 'insights'
  ]
  loop
    execute format('create policy "%1$s: select own" on public.%1$I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
end;
$$;

-- Audit log: users can read their own entries; writes go through triggers / log_user_action.
create policy "audit: read own" on public.audit_log
  for select to authenticated using (user_id = (select auth.uid()));

-- Anonymous visitors never touch financial tables.
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Helper views (security_invoker: RLS of the caller applies)
-- ---------------------------------------------------------------------------
create view public.account_latest_balances
with (security_invoker = true) as
select distinct on (b.account_id)
  b.account_id,
  b.user_id,
  b.as_of,
  b.balance,
  b.currency,
  b.source
from public.account_balances b
order by
  b.account_id,
  b.as_of desc,
  case b.source when 'import' then 0 when 'blockchain' then 0 when 'manual' then 1 when 'seed' then 2 else 3 end,
  b.created_at desc;

create view public.wallet_latest_holdings
with (security_invoker = true) as
select distinct on (h.wallet_id, h.asset_id)
  h.wallet_id,
  h.user_id,
  h.asset_id,
  h.as_of,
  h.quantity
from public.wallet_holdings h
order by h.wallet_id, h.asset_id, h.as_of desc;

revoke all on public.account_latest_balances from anon;
revoke all on public.wallet_latest_holdings from anon;

-- ---------------------------------------------------------------------------
-- Data deletion (database rows; storage objects are removed through the Storage API)
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_financial_data()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  delete from public.inbox_items where user_id = uid;
  delete from public.insights where user_id = uid;
  delete from public.transactions where user_id = uid;
  delete from public.recurring_series where user_id = uid;
  delete from public.accounts where user_id = uid;
  delete from public.documents where user_id = uid;
  delete from public.categorization_rules where user_id = uid;
  delete from public.categories where user_id = uid;
  delete from public.institutions where owner_id = uid;
  delete from public.financial_entities where user_id = uid and kind <> 'personal';
  insert into public.audit_log (user_id, actor, action, details)
  values (uid, 'user', 'data.deleted_all', '{}'::jsonb);
end;
$$;
revoke all on function public.delete_my_financial_data() from public, anon;
grant execute on function public.delete_my_financial_data() to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for original documents, one folder per user
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  15728640,
  array[
    'text/csv',
    'application/x-ofx',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do nothing;

create policy "documents bucket: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "documents bucket: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "documents bucket: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
