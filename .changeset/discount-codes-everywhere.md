---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

Shoppers enter discount codes on the cart page and in the checkout summary, and see the discount and the total they will be charged before the address; ACP sessions take `discounts.codes` (or `coupons`) and answer `discounts`, MCP agents get `cart_addCode` and `cart_removeCode`, and UCP checkouts total the cart's discount.
Breaking: `CommerceAdapter.cart` methods resolve `ShopperCart` and it gains required `addCode` and `removeCode`; `CartState` gains `totals`, `promotions` and `errorCode`; the elements' `cart` projection needs `discountTotalMinor`, `totalMinor` and `codes` (the templates' `fetchCart` fills them).
ACP sessions now carry `discounts` and `capabilities.extensions`; `POST /api/cart/codes` refuses `.` and `..`.
A store already scaffolded copies `src/lib/api.ts` (Astro) or `lib/api.ts` (Next.js) from the new template.
