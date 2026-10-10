-- "PAGAMENTO CARTA" on an Italian statement is a purchase paid by card
-- ("PAGAMENTO CARTA SPOTIFY", "Pagamento carta - Trasporti"), not the payment of
-- a credit card bill. The system rule hid those purchases as transfers; only the
-- explicit wording of a bill payment stays.
update public.categorization_rules
set pattern = 'PAGAMENTO CARTA DI CREDITO'
where user_id is null and pattern = 'PAGAMENTO CARTA';
notify pgrst, 'reload schema';
