-- Layout memory: what an import learned about a file structure it had never
-- seen (which column is which), so the next file with the same structure is
-- read deterministically. Recipes hold column indexes/positions (and, for a
-- learned PDF layout, the issuing bank's name) — never other document text,
-- account identifiers or money. Replaces pdf_reader_evidence,
-- which only certified built-in readers and never recorded a layout.
create table public.import_layouts (
  user_id uuid not null references auth.users(id) on delete cascade,
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('table', 'pdf-table')),
  recipe jsonb not null check (jsonb_typeof(recipe) = 'object' and pg_column_size(recipe) <= 8192),
  uses integer not null default 0 check (uses >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, signature)
);
create index import_layouts_user_kind_idx on public.import_layouts (user_id, kind);
alter table public.import_layouts enable row level security;
create policy import_layouts_select on public.import_layouts
  for select to authenticated using (user_id = (select auth.uid()));
-- Recipes decide how the user's statements are read: only the import worker
-- writes them, after it verified the job, the document and the result.
revoke all on public.import_layouts from public, anon, authenticated;
grant select on public.import_layouts to authenticated;
grant select, insert, update, delete on public.import_layouts to service_role;

drop table if exists public.pdf_reader_evidence;
notify pgrst, 'reload schema';
