export interface StripeFakeOptions {
  /** The address to bind; 127.0.0.1 by default, 0.0.0.0 when a container must reach it. */
  host?: string
  /** 0, the default, takes a free port. */
  port?: number
  /** The key the adapter's requests must carry; sk_test_mock by default. */
  secretKey?: string
  /** Where a confirm posts the signed payment_intent.succeeded; with webhookSecret. */
  webhookUrl?: string
  webhookSecret?: string
  /** A key the fake refuses 403, as Stripe refuses a restricted key without the permission. */
  restrictedKey?: string
}

/** One request as the fake read it: its form fields flattened (`metadata[k]` stays a key of its own). */
export interface ReceivedRequest {
  method: string
  path: string
  params: Record<string, string>
  idempotencyKey: string | undefined
}

export interface StripeFake {
  port: number
  /** The fake's origin as this host reaches it. */
  url: string
  /** Every request so far, in arrival order. */
  received: ReceivedRequest[]
  close(): Promise<void>
}

/** The header a delivered webhook carries its signature in. */
export const SIGNATURE_HEADER: string

export function startStripeFake(options?: StripeFakeOptions): Promise<StripeFake>

/** The payment methods whose off-session confirm does not capture: an HTTP error, or an intent left in `status`. */
export const SAVED_CARD_OUTCOMES: Record<
  string,
  | { statusCode: number; error: { type: string; code?: string; decline_code?: string; message: string } }
  | { status: string; statusCode?: undefined }
>
