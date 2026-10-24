import type { PaymentDriver } from '@nymbalhq/sdk'

/**
 * For a store whose payments need no shopper input (the native stub): nothing to collect, and nothing confirmed here.
 * An order the stub holds as `requires_action` stays pending until its webhook pays it.
 */
export const testModeDriver: PaymentDriver = {
  mount(el) {
    el.innerHTML = '<p class="nymbal-payment-note">Test mode — payment skipped</p>'
  },
  confirm() {
    return Promise.resolve({ ok: true, confirmed: false })
  },
}
