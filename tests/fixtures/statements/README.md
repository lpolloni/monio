# Statement fixtures (synthetic)

**Every file in this directory is fictional test data.** Names, companies,
account numbers, IBANs, CPF/CNPJ-like identifiers, card numbers, amounts and
descriptions were invented for tests and do not belong to real people or
accounts. Institution names (Nubank, N26, Revolut, MPS, XP, Santander...) are
used only because the files imitate the *layout* of their public export
formats; the layouts themselves must be validated against real exports before
production use.

| File | Format | Notes |
| --- | --- | --- |
| `nubank-account.csv` | Nubank account CSV | duplicate legit purchase (two rows, distinct ids), Pix transfer to own Revolut account, card bill payment ("Pagamento de fatura"), Netflix/Spotify subscriptions |
| `nubank-pj.csv` | Nubank PJ (business) CSV | counterparties with CNPJ-like identifiers |
| `nubank-card.csv` | Nubank credit card CSV | positive = purchase; payment and refund are negative; USD purchase converted to BRL |
| `n26.csv` | N26 CSV (v1 header) | foreign-currency purchase (USD), transfer to own Revolut account |
| `n26-v2.csv` | N26 CSV (v2 header) | main account + Space, GBP purchase |
| `revolut.csv` | Revolut CSV | fees, EUR/USD pockets, DECLINED/REVERTED/PENDING rows, prompt-injection-looking description |
| `mps.csv` | MPS CSV (`;`, comma decimal) | exact duplicate rows (legit), transfer to own N26 account, wrapped description row |
| `xp.csv` | XP CSV | `SALDO ANTERIOR` opening balance row, running balance |
| `santander-br.csv` | Santander Brasil CSV, **Windows-1252 encoded** | preamble lines, `SALDO ANTERIOR`, balance only on some rows |
| `generic-unknown-bank.csv` | Unknown bank CSV | 3-line preamble before the header, prompt-injection-looking description |
| `santander-br-checking.ofx` | OFX 1.x SGML (CHARSET 1252) | checking account, card bill payment, own-account transfer |
| `nubank-card.ofx` | OFX 2.x XML | credit card statement, ORIGCURRENCY (USD) purchase, XML entities |

XLSX and PDF fixtures are generated inside the tests with
`tests/helpers/xlsx-builder.ts` and `tests/helpers/pdf-writer.ts`.
