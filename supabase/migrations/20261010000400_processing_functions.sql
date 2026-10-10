-- Bulk helpers used by import post-processing. SECURITY INVOKER: the caller's RLS
-- applies, so a user can only touch their own rows.

create or replace function public.apply_transaction_updates(p_updates jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if jsonb_typeof(p_updates) <> 'array' then
    raise exception 'p_updates must be a JSON array';
  end if;
  if jsonb_array_length(p_updates) > 5000 then
    raise exception 'too many updates in one call';
  end if;

  with u as (
    select (item ->> 'id')::uuid as id, item
    from jsonb_array_elements(p_updates) as item
  )
  update public.transactions t
  set
    category_id = case when u.item ? 'category_id' then (u.item ->> 'category_id')::uuid else t.category_id end,
    category_source = case when u.item ? 'category_source' then u.item ->> 'category_source' else t.category_source end,
    category_confidence = case when u.item ? 'category_confidence' then (u.item ->> 'category_confidence')::numeric else t.category_confidence end,
    merchant = case when u.item ? 'merchant' then u.item ->> 'merchant' else t.merchant end,
    classification = case when u.item ? 'classification' then u.item ->> 'classification' else t.classification end,
    transfer_group_id = case when u.item ? 'transfer_group_id' then (u.item ->> 'transfer_group_id')::uuid else t.transfer_group_id end,
    counterpart_transaction_id = case when u.item ? 'counterpart_transaction_id' then (u.item ->> 'counterpart_transaction_id')::uuid else t.counterpart_transaction_id end,
    duplicate_of = case when u.item ? 'duplicate_of' then (u.item ->> 'duplicate_of')::uuid else t.duplicate_of end,
    recurring_series_id = case when u.item ? 'recurring_series_id' then (u.item ->> 'recurring_series_id')::uuid else t.recurring_series_id end
  from u
  where t.id = u.id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.apply_transaction_updates(jsonb) from public, anon;
grant execute on function public.apply_transaction_updates(jsonb) to authenticated, service_role;

-- Records rule usage without granting users update rights on system rules.
create or replace function public.record_rule_hits(p_rule_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.categorization_rules
  set hits = hits + 1, last_hit_at = now()
  where id = any(p_rule_ids)
    and (user_id is null or user_id = auth.uid() or auth.role() = 'service_role');
$$;
revoke all on function public.record_rule_hits(uuid[]) from public, anon;
grant execute on function public.record_rule_hits(uuid[]) to authenticated, service_role;
