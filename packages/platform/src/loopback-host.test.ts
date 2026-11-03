import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from './auth-secret.js'

// A store that signs tokens with the published default secret may listen only where no other machine can reach it:
// the loopback range 127.0.0.0/8, ::1 and localhost. Every other host, the wildcards `0.0.0.0` and `::` included, is
// reachable from elsewhere.

const octet = fc.integer({ min: 0, max: 255 })

const loopback = fc.oneof(
  fc.tuple(octet, octet, octet).map(([b, c, d]) => `127.${b}.${c}.${d}`),
  fc.constantFrom('::1', 'localhost'),
)

const notLoopback = fc.oneof(
  fc
    .tuple(
      octet.filter((a) => a !== 127),
      octet,
      octet,
      octet,
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  fc.domain().filter((d) => d.toLowerCase() !== 'localhost'),
  fc.constantFrom('::', '0.0.0.0', 'fe80::1', '2001:db8::1', '::2'),
)

describe('AC-9: isLoopbackHost', () => {
  it('AC-9: of the eight named hosts, exactly 127.0.0.1, 127.0.0.2, localhost and ::1 are loopback', () => {
    const hosts = [
      '0.0.0.0',
      '::',
      '192.168.1.20',
      'shop.example.com',
      '127.0.0.1',
      '127.0.0.2',
      'localhost',
      '::1',
    ]
    const loopbackHosts = new Set(['127.0.0.1', '127.0.0.2', 'localhost', '::1'])

    expect(hosts.map((h) => [h, isLoopbackHost(h)])).toEqual(
      hosts.map((h) => [h, loopbackHosts.has(h)]),
    )
  })

  it('AC-9: over generated hosts, isLoopbackHost is true for every 127.0.0.0/8 address, ::1 and localhost, and false for every other address and name', () => {
    const host = fc.oneof(
      loopback.map((h) => ({ h, loopback: true })),
      notLoopback.map((h) => ({ h, loopback: false })),
    )
    fc.assert(
      fc.property(host, ({ h, loopback: expected }) => {
        expect(isLoopbackHost(h), h).toBe(expected)
      }),
      { numRuns: 500 },
    )
  })
})
