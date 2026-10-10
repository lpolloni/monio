-- Fix: deleting a user cascades to their transactions; the audit trigger must not
-- try to log those deletions (the owner row is already gone, which violated the
-- audit_log -> auth.users foreign key and blocked account deletion).
create or replace function public.audit_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from auth.users u where u.id = old.user_id) then
      return old;
    end if;
    insert into public.audit_log (user_id, actor, action, target_table, target_id, details)
    values (old.user_id, case when auth.uid() is null then 'system' else 'user' end,
            'transaction.deleted', 'transactions', old.id,
            jsonb_build_object('amount', old.amount::text, 'currency', old.currency, 'booked_on', old.booked_on));
    return old;
  end if;

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
end;
$$;
