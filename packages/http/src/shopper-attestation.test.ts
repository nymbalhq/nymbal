import { randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createShopperAttestation } from './shopper-attestation.js'

// The storefront forward's proof of the shopper's address: a token the API mints for one address and verifies only
// for that address, under the key that minted it, within its lifetime. Anything else verifies to null.

const TTL = 60_000

const address = fc.oneof(
  fc.ipV4(),
  fc.ipV6(),
  fc.ipV4().map((v4) => `::ffff:${v4}`),
)
/** Any instant from 1970 to 2100, in ms. */
const clock = fc.integer({ min: 0, max: 4_102_444_800_000 })
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** Every character a token could hold, and the separator. */
const TOKEN_CHARS = [...new Set(`${BASE64URL}~.:`)]

describe('AC-7: a shopper attestation verifies for its own address, key and lifetime only', () => {
  it('AC-7: over generated IPv4, IPv6 and mapped addresses and clocks, verify(mint(ip, t), t + d) is ip for 0 <= d < ttl and null from d = ttl on', () => {
    fc.assert(
      fc.property(
        address,
        clock,
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.nat(),
        fc.nat(),
        (ip, t, ttl, inside, past) => {
          const attestation = createShopperAttestation(randomBytes(32), ttl)
          const token = attestation.mint(ip, t)

          expect(attestation.verify(token, t)).toBe(ip)
          expect(attestation.verify(token, t + (inside % ttl))).toBe(ip)
          expect(attestation.verify(token, t + ttl - 1)).toBe(ip)
          expect(attestation.verify(token, t + ttl)).toBeNull()
          expect(attestation.verify(token, t + ttl + past)).toBeNull()
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-7: the default lifetime is 60 s: a token verifies at 59 999 ms and not at 60 000 ms', () => {
    fc.assert(
      fc.property(address, clock, (ip, t) => {
        const attestation = createShopperAttestation()
        const token = attestation.mint(ip, t)

        expect(attestation.verify(token, t + TTL - 1)).toBe(ip)
        expect(attestation.verify(token, t + TTL)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })

  it('AC-7: any single-character change to a token, anywhere in it, verifies to null', () => {
    fc.assert(
      fc.property(
        address,
        clock,
        fc.nat(),
        fc.constantFrom(...TOKEN_CHARS),
        (ip, t, at, replacement) => {
          const attestation = createShopperAttestation(randomBytes(32))
          const token = attestation.mint(ip, t)
          const i = at % token.length
          fc.pre(token[i] !== replacement)
          const changed = `${token.slice(0, i)}${replacement}${token.slice(i + 1)}`

          expect(attestation.verify(token, t)).toBe(ip)
          expect(attestation.verify(changed, t)).toBeNull()
        },
      ),
      { numRuns: 500 },
    )
  })

  it("AC-7: every other base64url character in the mac's last place verifies to null", () => {
    fc.assert(
      fc.property(address, clock, (ip, t) => {
        const attestation = createShopperAttestation(randomBytes(32))
        const token = attestation.mint(ip, t)
        const last = token.at(-1)!
        const verified = [...BASE64URL]
          .filter((c) => c !== last)
          .map((c) => attestation.verify(`${token.slice(0, -1)}${c}`, t))

        expect(attestation.verify(token, t)).toBe(ip)
        expect(verified).toEqual(verified.map(() => null))
      }),
      { numRuns: 40 },
    )
  })

  it('AC-7: a token verifies under an attestation holding the key that minted it and under no other key', () => {
    fc.assert(
      fc.property(address, clock, (ip, t) => {
        const key = randomBytes(32)
        const minter = createShopperAttestation(key)
        const sameKey = createShopperAttestation(Buffer.from(key))
        const otherKey = createShopperAttestation(randomBytes(32))
        const defaultKey = createShopperAttestation()
        const token = minter.mint(ip, t)

        expect(sameKey.verify(token, t)).toBe(ip)
        expect(otherKey.verify(token, t)).toBeNull()
        expect(defaultKey.verify(token, t)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })

  it('AC-7: a token with a segment missing or one added, a non-string and an empty value verify to null', () => {
    fc.assert(
      fc.property(address, clock, fc.stringMatching(/^[A-Za-z0-9_-]{0,12}$/), (ip, t, extra) => {
        const attestation = createShopperAttestation(randomBytes(32))
        const token = attestation.mint(ip, t)
        const segments = token.split('~')
        const altered = [
          segments.slice(1).join('~'),
          segments.slice(0, -1).join('~'),
          [segments[0], segments[2]].join('~'),
          `${token}~${extra}`,
          `${extra}~${token}`,
          [segments[0], segments[1], extra, segments[2]].join('~'),
        ]
        const notStrings: unknown[] = [
          undefined,
          null,
          0,
          Number(segments[1]),
          true,
          [token],
          { token },
          Buffer.from(token),
        ]

        expect(attestation.verify(token, t)).toBe(ip)
        expect(altered.map((value) => attestation.verify(value, t))).toEqual(
          altered.map(() => null),
        )
        expect(notStrings.map((value) => attestation.verify(value, t))).toEqual(
          notStrings.map(() => null),
        )
        expect(attestation.verify('', t)).toBeNull()
      }),
      { numRuns: 100 },
    )
  })
})
