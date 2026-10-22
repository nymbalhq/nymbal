---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

Checkout is now a Nymbal element, `nymbal-checkout`, so a store can restyle or replace it like the cart page.

- **The element:** the contact, shipping and payment steps (billing sits in the payment step), the step indicator, the
  error and the order summary, in an open shadow root. Its `parts` and `slots` are listed in its schema. The shipping
  and billing addresses are `nymbal-address-form` elements.
- **Payment:** the page puts `<nymbal-payment-element slot="payment">` inside `nymbal-checkout`. The payment element
  stays in the light DOM and mounts its driver once, whichever step the shopper is on. Place Order is disabled while
  the payment element reports `error`.
- **Event:** `nymbal:checkout:placed` (`{ orderNumber }`) fires after the checkout store is reset. The page decides
  where to go next. `@nymbalhq/react` has a generated `Checkout` wrapper with `onPlaced`, and it passes its children
  through.
- **Behaviour, the same on both templates:**
  - A billing address that differs from shipping reaches the order. On Astro it used to throw.
  - A double click on Continue moves one step and submits nothing on the next step.
  - Place Order sends one order request per press.
- **Templates:** the Astro and Next.js checkout pages now render the element. Billing test ids are `billing-*` on both
  templates. Removed: Astro's `scripts/checkout.ts`, `AddressForm.astro`, `CheckoutSteps.astro` and
  `styles/pages/checkout.css`, and Next's `CheckoutForm.tsx`, `CheckoutSteps.tsx` and `checkout.module.css`.
- **Fixes:**
  - Every generated React wrapper takes a `slot` prop.
  - `nymbal-payment-element` no longer throws when its `client` changes after its first render.
