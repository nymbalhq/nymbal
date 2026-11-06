/**
 * What the built-in payment drivers load from outside the store, by content security policy directive. A storefront's
 * page policy allows these, so the payment step works under it without the storefront naming a payment provider.
 */
export const PAYMENT_SOURCES = {
  script: ['https://js.stripe.com'],
  frame: ['https://js.stripe.com', 'https://hooks.stripe.com'],
  connect: ['https://api.stripe.com'],
} as const
