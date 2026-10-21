---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

The product page adds the quantity and the variant the shopper picks, the same way on both templates.

- `@nymbalhq/types` exports the one stock rule, `stockLevel(stock)` (`'out'` at 0 or below, `'low'` below 5, else
  `'in'`), and `STOCK_LABELS`. Both PDP badges render from it, with `data-level` on `stock-badge`. Add-to-cart is
  disabled exactly when the selected variant's stock is 0 or below, and a product with no variants is out of stock.
- `<nymbal-add-to-cart qty>` (React: `qty`) adds that many units: a whole number clamped to 1-99, and anything else
  is 1. `nymbal:cart:item-added` carries `{ variantId, qty }`.
- Both PDPs wire a `<nymbal-quantity-selector>` to add-to-cart, and the quantity starts again at 1 when the variant
  changes. `<nymbal-quantity-selector>` shows and emits a whole number: a typed or set value is truncated toward zero
  and clamped to `min`-`max`, and anything that is not a number is `min`, so a typed 2.7 shows and adds 2. Astro's
  `/cart` steps each line with `<nymbal-quantity-selector>`, as Next does. On both templates, decrement stops at 1 and
  the line's `cart-remove-<variantId>` button removes it.
- The product read model always serves `variants[].options` as `VariantOption[]`, including for products projected
  from older events that stored the options as a JSON string.

**Breaking.** `<nymbal-variant-selector>` takes variant options as `VariantOption[]` only. Its `options` attribute
(React: the `options` prop) is gone, so the selector reads its groups from the product's variants alone. On Astro's
`/cart`, decrement at 1 no longer removes the line. Next's unused `components/server/StockBadge.tsx` is removed.
