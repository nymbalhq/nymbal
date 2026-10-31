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
}

export interface StripeFake {
  port: number
  /** The fake's origin as this host reaches it. */
  url: string
  close(): Promise<void>
}

/** The header a delivered webhook carries its signature in. */
export const SIGNATURE_HEADER: string

export function startStripeFake(options?: StripeFakeOptions): Promise<StripeFake>
