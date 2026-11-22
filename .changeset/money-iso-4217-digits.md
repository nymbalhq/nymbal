---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/admin': minor
'@nymbalhq/importers': minor
'@nymbalhq/shipping-easypost': minor
---

Amounts read with each currency's ISO 4217 minor units, from `CURRENCY_MINOR_UNITS` and `currencyExponent` in `@nymbalhq/types`: the admin shows 1999 JPY as JP¥1,999 and 1999 KWD as KWD 1.999, and its refund and price inputs take amounts in those digits.
Breaking for HUF, IDR, COP, PKR, IQD and the other currencies where `Intl` and ISO 4217 differ: emails, the admin, the WooCommerce importer and EasyPost now read them with ISO's digits (1999 HUF reads HUF 19.99, was HUF 1,999); stored amounts do not change.
EasyPost refuses a rate in a currency with no ISO 4217 minor units, one listed without them (such as XXX) or not listed at all (such as ZZZ), and needs `@nymbalhq/types` 1.10.0 or later.
