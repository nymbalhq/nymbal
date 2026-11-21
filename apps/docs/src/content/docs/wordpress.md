---
title: Add a Nymbal cart to WordPress
description: Put an add-to-cart button, a mini-cart and a drawer on a WordPress theme, and take payment on your Nymbal store.
---

A WordPress site can sell through Nymbal without moving to a Nymbal storefront. The theme loads one script and prints
Nymbal elements where it wants them. Shoppers add to the cart on WordPress and pay on your store's own `/checkout`,
with the same cart.

## Add it to the theme

In the theme's `<head>`, with the store's API and storefront URLs and the version you want:

```html
<meta name="nymbal:api-url" content="https://shop.example.com" />
<meta name="nymbal:store-url" content="https://shop.example.com" />
<script type="module" src="https://cdn.jsdelivr.net/npm/@nymbalhq/web-components@<version>/dist/kit.js"></script>
```

Use an exact version: a range would change your cart's code when a new one is published.

Then print the elements in your theme files, with Nymbal variant ids:

```html
<nymbal-mini-cart></nymbal-mini-cart>
<nymbal-add-to-cart variant-id="<nymbal variant id>"></nymbal-add-to-cart>
```

The script adds a cart drawer and a toast to the page if your theme prints none. Print elements from theme files, as
the post editor may strip tags it does not know.

## What the bundle has

`nymbal-add-to-cart`, `nymbal-mini-cart`, `nymbal-cart-drawer`, `nymbal-quantity-selector`, `nymbal-toast` and
`nymbal-notify-me`.

- **Quantity**: wrap a `nymbal-quantity-selector` and its `nymbal-add-to-cart` in one element. The quantity goes to the
  button in the nearest container they share.
- **Back-in-stock alerts**: print `<nymbal-notify-me variant-id="…" stock="0">`; it needs `stock`, and it appears only
  when the store delivers email. The links in the mail go to your store.

## What the store needs

- Your WordPress origin in `http.cors.kitOrigins`, and your store's origin in `http.cors.allowedOrigins`. A kit origin
  reaches only the cart, the CSRF token, capabilities and alert sign-ups, so any plugin on that site can act on a
  visitor's cart, and none can reach their account.
- The WordPress site and the API on one registrable domain, such as `www.example.com` and `shop.example.com`. The
  store's cookies are `SameSite=Lax`, so a site on another domain cannot keep a cart.

If the set-up cannot work, nothing is shown and the browser console says why: a missing or malformed meta tag, an API
the page cannot read, or a site on another domain.
