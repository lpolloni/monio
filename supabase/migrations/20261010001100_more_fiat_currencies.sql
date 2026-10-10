-- Fiat currencies statements may be issued in, beyond the first five. Mirrors
-- src/domain/money/currencies.ts; accounts and transactions reference this table.
insert into public.currencies (code, kind, name, decimals, display_decimals, pegged_to) values
  ('PYG', 'fiat', 'Paraguayan guarani', 0, 0, null),
  ('ARS', 'fiat', 'Argentine peso', 2, 2, null),
  ('CLP', 'fiat', 'Chilean peso', 0, 0, null),
  ('COP', 'fiat', 'Colombian peso', 2, 2, null),
  ('MXN', 'fiat', 'Mexican peso', 2, 2, null),
  ('UYU', 'fiat', 'Uruguayan peso', 2, 2, null),
  ('PEN', 'fiat', 'Peruvian sol', 2, 2, null),
  ('CAD', 'fiat', 'Canadian dollar', 2, 2, null),
  ('AUD', 'fiat', 'Australian dollar', 2, 2, null),
  ('JPY', 'fiat', 'Japanese yen', 0, 0, null),
  ('CNY', 'fiat', 'Chinese yuan', 2, 2, null),
  ('INR', 'fiat', 'Indian rupee', 2, 2, null),
  ('SEK', 'fiat', 'Swedish krona', 2, 2, null),
  ('NOK', 'fiat', 'Norwegian krone', 2, 2, null),
  ('DKK', 'fiat', 'Danish krone', 2, 2, null),
  ('PLN', 'fiat', 'Polish zloty', 2, 2, null),
  ('CZK', 'fiat', 'Czech koruna', 2, 2, null),
  ('HUF', 'fiat', 'Hungarian forint', 2, 2, null),
  ('TRY', 'fiat', 'Turkish lira', 2, 2, null),
  ('ZAR', 'fiat', 'South African rand', 2, 2, null)
on conflict (code) do nothing;
notify pgrst, 'reload schema';
