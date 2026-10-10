-- Worker-confirmed learning evidence. Never stores PDF text, account identifiers or money.
create table public.pdf_reader_evidence (
  user_id uuid not null references auth.users(id) on delete cascade,
  layout_hash text not null check (layout_hash ~ '^[0-9a-f]{64}$'),
  document_hash text not null check (document_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, layout_hash, document_hash)
);
alter table public.pdf_reader_evidence enable row level security;
create policy pdf_reader_evidence_select on public.pdf_reader_evidence
  for select to authenticated using (user_id = (select auth.uid()));
-- A browser must not be able to certify a parser, even for its own account.
revoke all on public.pdf_reader_evidence from public, anon, authenticated;
grant select on public.pdf_reader_evidence to authenticated;
grant select, insert, delete on public.pdf_reader_evidence to service_role;
notify pgrst, 'reload schema';
