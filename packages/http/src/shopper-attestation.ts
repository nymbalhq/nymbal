import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface ShopperAttestation {
  /** A token for `ip`, valid until `now + ttl`: `<ip>~<expiresMs>~<base64url mac>`. */
  mint(ip: string, now?: number): string
  /** The address `token` was minted for, or null when it is not a live token under this key. */
  verify(token: unknown, now?: number): string | null
}

/**
 * The API's proof, on a request it forwards to the storefront, of the shopper's address, so the storefront server's
 * own API calls for that shopper count against the shopper. The key lives only in this process: a token from another
 * process or a previous boot does not verify. `~` appears in no IPv4 or IPv6 address, so the three segments are
 * unambiguous.
 */
export function createShopperAttestation(
  key: Buffer = randomBytes(32),
  ttlMs = 60_000,
): ShopperAttestation {
  const sign = (ip: string, expires: number): string => {
    const body = `${ip}~${expires}`
    return `${body}~${createHmac('sha256', key).update(body).digest('base64url')}`
  }
  return {
    mint(ip, now = Date.now()) {
      return sign(ip, now + ttlMs)
    },
    verify(token, now = Date.now()) {
      if (typeof token !== 'string') return null
      const segments = token.split('~')
      if (segments.length !== 3) return null
      const [ip, expiresText] = segments as [string, string, string]
      if (ip === '' || !/^\d+$/.test(expiresText)) return null
      const expires = Number(expiresText)
      if (!Number.isSafeInteger(expires) || now >= expires) return null
      // The recomputed text, not the decoded mac: base64url's last character carries spare bits, so two texts can
      // decode to the same bytes.
      const expected = Buffer.from(sign(ip, expires))
      const given = Buffer.from(token)
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
      return ip
    },
  }
}
