/** What a payment driver's `confirm` answers: paid now, accepted without a payment yet, or refused with a reason. */
export type PaymentConfirmation = { ok: true; confirmed: boolean } | { ok: false; error: string }

/**
 * The browser half of a payments adapter, named by the `driver` of GET /api/capabilities' payments client. `mount`
 * renders whatever the shopper pays with inside `el`; `confirm` completes a payment the API left `requires_action`.
 */
export interface PaymentDriver {
  mount(el: HTMLElement, options: Record<string, string>): Promise<void> | void
  confirm(clientSecret: string): Promise<PaymentConfirmation>
}

// On globalThis, like the registered client: a page that loads two copies of the SDK still has one registry.
const DRIVERS_KEY = Symbol.for('nymbal.paymentDrivers')

function drivers(): Map<string, PaymentDriver> {
  const holder = globalThis as Record<symbol, Map<string, PaymentDriver> | undefined>
  holder[DRIVERS_KEY] ??= new Map()
  return holder[DRIVERS_KEY]
}

/** Registers `driver` under `name`, replacing any driver of that name. */
export function registerPaymentDriver(name: string, driver: PaymentDriver): void {
  drivers().set(name, driver)
}

export function getPaymentDriver(name: string): PaymentDriver | undefined {
  return drivers().get(name)
}
