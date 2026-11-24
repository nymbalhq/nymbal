/** Where the store check stopped. */
export type StoreStep = 'health' | 'home' | 'product' | 'cart' | 'quote' | 'checkout' | 'order'

/** What one check of a heartbeat run found. */
export interface HeartbeatResult {
  check: 'store' | 'card'
  /**
   * `unrecognised`: the store placed a real order for the heartbeat's address. `refund_failed`: a charge was captured
   * and is not known to be refunded in full, so money may be left on the card.
   */
  status:
    | 'ok'
    | 'failed'
    | 'unrecognised'
    | 'card_refused'
    | 'key_refused'
    | 'provider_unreachable'
    | 'refund_failed'
  /** The store check's step that failed. */
  step?: StoreStep
  detail: string
  startedAt: string
  durationMs: number
  /** The store check's order. */
  orderNumber?: string
  /** The card check's payment, when the provider holds one. */
  paymentId?: string
  /** How the provider answered the card check's refund, when it is ok. */
  refund?: 'succeeded' | 'pending'
}

/** Starts timing a check; the function it returns builds the check's result. */
export function timed(check: HeartbeatResult['check']) {
  const started = new Date()
  return (
    status: HeartbeatResult['status'],
    detail: string,
    extra: Partial<Pick<HeartbeatResult, 'step' | 'orderNumber' | 'paymentId' | 'refund'>> = {},
  ): HeartbeatResult => ({
    check,
    status,
    detail,
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    ...extra,
  })
}
