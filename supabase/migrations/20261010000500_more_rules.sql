-- Loan/mortgage installments get their own category, and broader deterministic
-- rules reduce how often the AI provider is consulted.

insert into public.categories (slug, kind, icon, hue) values ('loan_payment', 'expense', 'HandCoins', 30)
on conflict do nothing;

insert into public.categorization_rules (user_id, match_type, pattern, merchant, category_id, direction, priority, source)
select null, r.match_type, r.pattern, r.merchant, c.id, r.direction, r.priority, 'system'
from (values
  ('contains', 'TRATTORIA', null, 'dining', 'out', 40),
  ('contains', 'PIZZERIA', null, 'dining', 'out', 40),
  ('contains', 'RISTORANTE', null, 'dining', 'out', 40),
  ('contains', 'OSTERIA', null, 'dining', 'out', 40),
  ('contains', 'SUSHI', null, 'dining', 'out', 40),
  ('contains', 'PASTICCERIA', null, 'dining', 'out', 40),
  ('contains', 'RESTAURANTE', null, 'dining', 'out', 40),
  ('contains', 'LANCHONETE', null, 'dining', 'out', 40),
  ('contains', 'PADARIA', null, 'dining', 'out', 45),
  ('contains', 'MUTUO', null, 'loan_payment', 'out', 20),
  ('contains', 'FINANCIAMENTO', null, 'loan_payment', 'out', 20),
  ('contains', 'PARCELA EMPRESTIMO', null, 'loan_payment', 'out', 20),
  ('contains', 'RATA PRESTITO', null, 'loan_payment', 'out', 20),
  ('contains', 'CONDOMINIO', null, 'housing', 'out', 25),
  ('contains', 'GOOGLE *WORKSPACE', 'Google Workspace', 'subscriptions', 'out', 10),
  ('contains', 'ADOBE', 'Adobe', 'subscriptions', 'out', 15),
  ('contains', 'ALUGUEL', null, 'other_income', 'in', 20),
  ('contains', 'AFFITTO', null, 'other_income', 'in', 20),
  ('contains', 'EXCHANGED TO', null, 'fx_exchange', null, 10),
  ('contains', 'EXCHANGED FROM', null, 'fx_exchange', null, 10),
  ('contains', 'CAMBIO', null, 'fx_exchange', null, 30)
) as r(match_type, pattern, merchant, category_slug, direction, priority)
join public.categories c on c.slug = r.category_slug and c.user_id is null
on conflict do nothing;
