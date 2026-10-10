-- Security hardening from the integration security suite (tests/integration/security).

-- F1: delete_my_financial_data() always failed: as SECURITY INVOKER it could not insert
-- into audit_log directly. Log through the definer helper instead.
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
  perform public.log_user_action('data.deleted_all', null, null, '{}'::jsonb);
end;
$$;

-- F2: rows must never reference another user's private categories / institutions.
create or replace function public.assert_category_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.category_id is not null and exists (
    select 1 from public.categories c
    where c.id = new.category_id and c.user_id is not null and c.user_id is distinct from new.user_id
  ) then
    raise exception 'category is not available to this user' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger transactions_category_owner before insert or update of category_id, user_id on public.transactions
  for each row execute function public.assert_category_owner();
create trigger recurring_series_category_owner before insert or update of category_id, user_id on public.recurring_series
  for each row execute function public.assert_category_owner();
create trigger categorization_rules_category_owner before insert or update of category_id, user_id on public.categorization_rules
  for each row execute function public.assert_category_owner();

create or replace function public.assert_institution_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inst uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  if inst is not null and exists (
    select 1 from public.institutions i
    where i.id = inst and i.owner_id is not null and i.owner_id is distinct from new.user_id
  ) then
    raise exception 'institution is not available to this user' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger accounts_institution_owner before insert or update of institution_id, user_id on public.accounts
  for each row execute function public.assert_institution_owner('institution_id');
create trigger documents_institution_owner before insert or update of detected_institution_id, user_id on public.documents
  for each row execute function public.assert_institution_owner('detected_institution_id');

-- F3: rule usage counters are per caller and never touch shared system rules.
create or replace function public.record_rule_hits(p_rule_ids uuid[])
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.categorization_rules
  set hits = hits + 1, last_hit_at = now()
  where id = any(p_rule_ids[1:5000]) and user_id = (select auth.uid());
$$;
revoke all on function public.record_rule_hits(uuid[]) from public, anon;
grant execute on function public.record_rule_hits(uuid[]) to authenticated, service_role;

-- F4: no private key material anywhere in a watched identifier (also inside descriptors).
alter table public.crypto_wallets drop constraint if exists crypto_wallets_public_identifier_check1;
alter table public.crypto_wallets add constraint crypto_wallets_no_private_material check (
  public_identifier !~* '^\s*[xyztuv]prv'
  and public_identifier !~* '(^|[^1-9a-z])[xyztuv]prv[1-9a-z]{100,}'
  and public_identifier !~ '^\s'
  and public_identifier !~ '\s$'
  and public_identifier !~* '^(0x)?[0-9a-f]{64}$'
);

-- F6: a document's storage path must live in its owner's folder, without traversal.
alter table public.documents add constraint documents_storage_path_owned check (
  split_part(storage_path, '/', 1) = user_id::text
  and storage_path !~ '(^|/)\.\.?(/|$)'
  and storage_path !~* '%2e|%2f|\\'
);

-- Hardening: inbox items may only reference the owner's transactions.
create or replace function public.assert_inbox_transactions_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if cardinality(new.transaction_ids) > 0 and exists (
    select 1 from public.transactions t
    where t.id = any(new.transaction_ids) and t.user_id is distinct from new.user_id
  ) then
    raise exception 'transaction is not available to this user' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger inbox_items_transactions_owner before insert or update of transaction_ids, user_id on public.inbox_items
  for each row execute function public.assert_inbox_transactions_owner();

-- Hardening: bound what users can write into their own audit trail.
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
  p_action := left(p_action, 80);
  if p_action !~ '^[A-Za-z][A-Za-z0-9_.:-]{1,79}$' then
    raise exception 'invalid action name';
  end if;
  if pg_column_size(coalesce(p_details, '{}'::jsonb)) > 4096 then
    raise exception 'details too large';
  end if;
  insert into public.audit_log (user_id, actor, action, target_table, target_id, details)
  values (auth.uid(), 'user', p_action, p_target_table, p_target_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

-- Hardening: TRUNCATE bypasses RLS; trigger/references are never needed by API roles.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;
-- Objects created by future migrations are not exposed to anonymous visitors by default.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke all on sequences from anon;
