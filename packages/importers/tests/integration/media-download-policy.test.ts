import { isIP } from 'node:net'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaStorage } from '@nymbalhq/types'
import { downloadImage, isPublicAddress } from '../../src/woocommerce/media.js'

// What the importer may fetch for a product image: http(s) only, from a host whose every resolved address is public,
// unless the host is the WooCommerce store's own (`allowHost`); a redirect is followed only to a URL that passes the
// same check, at most three hops; and only an answer typed as a supported image is stored. The address lookup and
// fetch are injected (lookup) and stubbed (fetch), so nothing here touches the network. The stub fetch follows a
// redirect itself unless asked for `redirect: 'manual'`, as fetch does.

const PUBLIC = '93.184.215.14'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

interface Route {
  status: number
  headers?: Record<string, string>
  body?: Uint8Array
}

const image = (contentType?: string): Route => ({
  status: 200,
  headers: contentType === undefined ? {} : { 'content-type': contentType },
  body: JPEG,
})
const redirect = (location: string): Route => ({ status: 302, headers: { location } })

/** A URL as the URL parser writes it, so a route matches however the caller spelled its host. */
const normal = (url: string): string => new URL(url).href

/**
 * A web of routes by URL, `fallback` for any other; every URL fetch is asked for is recorded (as the parser writes
 * it), hop by hop.
 */
function web(routes: Record<string, Route>, fallback?: Route) {
  const requested: string[] = []
  const table = new Map(Object.entries(routes).map(([url, route]) => [normal(url), route]))
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    let url = normal(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    for (let hop = 0; hop < 20; hop++) {
      requested.push(url)
      const route = table.get(url) ?? fallback
      if (route === undefined) throw new TypeError(`fetch failed: ${url}`)
      const location = route.headers?.location
      if (route.status >= 300 && route.status < 400 && location && init?.redirect !== 'manual') {
        url = new URL(location, url).href
        continue
      }
      return new Response(route.body === undefined ? null : new Uint8Array(route.body), {
        status: route.status,
        headers: route.headers ?? {},
      })
    }
    throw new TypeError('redirect count exceeded')
  }
  vi.stubGlobal('fetch', fetchStub)
  return { requested }
}

/** A resolver over a fixed table; an IP literal resolves to itself, an unknown name fails as DNS does. */
function lookupOf(table: Record<string, string[]>) {
  return async (host: string): Promise<string[]> => {
    const bare = host.replace(/^\[|\]$/g, '')
    if (isIP(bare) !== 0) return [bare]
    const found = table[bare.toLowerCase()]
    if (found === undefined)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return found
  }
}

function recordingStorage() {
  const puts: Array<{ key: string; contentType: string }> = []
  const storage: MediaStorage = {
    capabilities: () => ['put'],
    async put(key, _body, contentType) {
      puts.push({ key, contentType })
      return { url: `/imported-media/${key}` }
    },
  }
  return { storage, puts }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- addresses ----------------------------------------------------------------------------------------------------

const ipv4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const v4Base = (dotted: string): number =>
  dotted.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)

/** An address inside `base/prefix`. */
const inV4 = (base: string, prefix: number) =>
  fc.integer({ min: 0, max: 2 ** (32 - prefix) - 1 }).map((offset) => ipv4(v4Base(base) + offset))

const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16))
const v6With = (first: fc.Arbitrary<number>) =>
  fc
    .tuple(first, fc.array(hextet, { minLength: 7, maxLength: 7 }))
    .map(([h, rest]) => [h.toString(16), ...rest].join(':'))

const blockedV4 = fc.oneof(
  inV4('127.0.0.0', 8),
  inV4('10.0.0.0', 8),
  inV4('172.16.0.0', 12),
  inV4('192.168.0.0', 16),
  inV4('100.64.0.0', 10),
  inV4('169.254.0.0', 16),
  fc.constant('0.0.0.0'),
)

/** The IPv4-mapped IPv6 forms of an IPv4 address: dotted, and the hex form a URL parser writes. */
function mapped(v4: string): string[] {
  const n = v4Base(v4)
  return [`::ffff:${v4}`, `::ffff:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`]
}

const blockedAddress = fc.oneof(
  blockedV4,
  fc.constantFrom('::1', '::'),
  v6With(fc.integer({ min: 0xfe80, max: 0xfebf })),
  v6With(fc.integer({ min: 0xfc00, max: 0xfdff })),
  fc.tuple(blockedV4, fc.boolean()).map(([v4, hex]) => mapped(v4)[hex ? 1 : 0]!),
)

const publicAddress = fc.oneof(
  inV4('8.0.0.0', 8),
  inV4('93.184.0.0', 16),
  fc.constantFrom(
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '::ffff:8.8.8.8',
    '2001:4860:4860::8888',
  ),
  v6With(fc.constant(0x2606)),
)

describe('AC-14: isPublicAddress', () => {
  it('AC-14: is false for every loopback, private, shared, link-local, unique-local, unspecified or IPv4-mapped such address, and true for public ones on either side of each range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          blockedAddress.map((ip) => ({ ip, expected: false })),
          publicAddress.map((ip) => ({ ip, expected: true })),
        ),
        ({ ip, expected }) => {
          expect(isPublicAddress(ip), ip).toBe(expected)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('AC-14: downloadImage requests only what the policy allows', () => {
  it('AC-14: file:, data: and ftp: sources make no request and store nothing', async () => {
    const sources = [
      'file:///etc/passwd',
      'data:image/png;base64,iVBORw0KGgo=',
      'ftp://files.example.test/a.jpg',
    ]
    const { requested } = web({}, image('image/png'))
    const { storage, puts } = recordingStorage()
    const lookup = lookupOf({ 'files.example.test': [PUBLIC] })

    const results = []
    for (const src of sources) {
      results.push(await downloadImage(src, 'alt', storage, 'products/tee', { lookup }))
    }

    expect(results).toEqual(sources.map(() => null))
    expect(requested).toEqual([])
    expect(puts).toEqual([])
  })

  it('AC-14: a host any of whose resolved addresses is not public is never requested and nothing is stored, whatever public address it also has', async () => {
    const { storage, puts } = recordingStorage()
    await fc.assert(
      fc.asyncProperty(blockedAddress, fc.boolean(), async (blocked, withPublic) => {
        const { requested } = web({}, image('image/jpeg'))
        const host = 'img.cdn.test'
        const lookup = lookupOf({ [host]: withPublic ? [PUBLIC, blocked] : [blocked] })

        const result = await downloadImage(`https://${host}/a.jpg`, '', storage, 'products/tee', {
          lookup,
        })

        expect(result, blocked).toBeNull()
        expect(requested, blocked).toEqual([])
      }),
      { numRuns: 150 },
    )
    expect(puts).toEqual([])
  })

  it('AC-14: an address literal in the source is judged as its host: cloud metadata, loopback with a port and a mapped loopback are never requested', async () => {
    const sources = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:8080/admin.jpg',
      'http://[::ffff:127.0.0.1]/a.jpg',
      'http://[fd00::1]/a.jpg',
    ]
    const { requested } = web({}, image('image/jpeg'))
    const { storage, puts } = recordingStorage()

    const results = []
    for (const src of sources) {
      results.push(await downloadImage(src, '', storage, 'products/tee', { lookup: lookupOf({}) }))
    }

    expect(results).toEqual(sources.map(() => null))
    expect(requested).toEqual([])
    expect(puts).toEqual([])
  })

  it('AC-14: the allowed host is fetched whatever its address, matched case-insensitively with the port ignored, but its redirect to a non-public address is refused', async () => {
    const allowed = 'https://WC.Shop.test:8443/wp-content/uploads/tee.jpg'
    const bouncing = 'https://wc.shop.test/wp-content/uploads/bounce.jpg'
    const metadata = 'http://169.254.169.254/latest/meta-data/'
    const literal = 'http://[FD00::5]:8080/wp-content/uploads/cap.jpg'
    const { requested } = web({
      [allowed]: image('image/jpeg'),
      [bouncing]: redirect(metadata),
      [metadata]: image('image/jpeg'),
      [literal]: image('image/jpeg'),
    })
    const { storage, puts } = recordingStorage()
    const policy = { lookup: lookupOf({ 'wc.shop.test': ['10.0.0.5'] }), allowHost: 'wc.shop.test' }
    // A store at an IPv6 literal: its allowed host is the URL's hostname, brackets and all.
    const literalPolicy = { lookup: lookupOf({}), allowHost: new URL('http://[fd00::5]').hostname }

    const kept = await downloadImage(allowed, 'tee', storage, 'products/tee', policy)
    const refused = await downloadImage(bouncing, 'bounce', storage, 'products/tee', policy)
    const keptLiteral = await downloadImage(literal, 'cap', storage, 'products/cap', literalPolicy)

    expect(requested.includes(metadata)).toBe(false)
    expect(refused).toBeNull()
    expect(requested.includes(normal(literal))).toBe(true)
    expect(puts.map((p) => `/imported-media/${p.key}`)).toEqual([kept?.url, keptLiteral?.url])
  })

  it('AC-14: a redirect is followed only to a URL passing the same check, at most three hops', async () => {
    const hop = (n: number) => `https://cdn${n}.shop.test/img.jpg`
    const internal = 'http://internal.shop.test/img.jpg'
    const lookup = lookupOf({
      'cdn0.shop.test': [PUBLIC],
      'cdn1.shop.test': [PUBLIC],
      'cdn2.shop.test': [PUBLIC],
      'cdn3.shop.test': [PUBLIC],
      'cdn4.shop.test': [PUBLIC],
      'cdn9.shop.test': [PUBLIC],
      'internal.shop.test': ['10.1.2.3'],
    })
    const { requested } = web({
      [hop(0)]: redirect(hop(1)),
      [hop(1)]: redirect(hop(2)),
      [hop(2)]: redirect(hop(3)),
      [hop(3)]: image('image/jpeg'),
      'https://cdn9.shop.test/a.jpg': redirect(internal),
      [internal]: image('image/jpeg'),
    })
    const { storage, puts } = recordingStorage()

    const threeHops = await downloadImage(hop(0), '', storage, 'products/a', { lookup })
    const putsAfterThree = puts.length

    // Four hops: cdn1 → cdn2 → cdn3 → cdn4 → an image that must not be fetched.
    const four = {
      'https://cdn1.shop.test/four.jpg': redirect('https://cdn2.shop.test/four.jpg'),
      'https://cdn2.shop.test/four.jpg': redirect('https://cdn3.shop.test/four.jpg'),
      'https://cdn3.shop.test/four.jpg': redirect('https://cdn4.shop.test/four.jpg'),
      'https://cdn4.shop.test/four.jpg': redirect('https://cdn0.shop.test/four.jpg'),
      'https://cdn0.shop.test/four.jpg': image('image/jpeg'),
    }
    const second = web(four)
    const fourHops = await downloadImage(
      'https://cdn1.shop.test/four.jpg',
      '',
      storage,
      'products/b',
      {
        lookup,
      },
    )
    const third = web({
      'https://cdn9.shop.test/a.jpg': redirect(internal),
      [internal]: image('image/jpeg'),
    })
    const toInternal = await downloadImage(
      'https://cdn9.shop.test/a.jpg',
      '',
      storage,
      'products/c',
      {
        lookup,
      },
    )

    expect(threeHops?.url).toBe(`/imported-media/${puts[0]?.key}`)
    expect(requested).toEqual([hop(0), hop(1), hop(2), hop(3)])
    expect(fourHops).toBeNull()
    expect(second.requested.includes('https://cdn0.shop.test/four.jpg')).toBe(false)
    expect(toInternal).toBeNull()
    expect(third.requested.includes(internal)).toBe(false)
    expect(puts.length).toBe(putsAfterThree)
  })

  it('AC-14: an answer with no content type or one outside the supported image types is skipped and never stored; a supported one is stored with its own type', async () => {
    const lookup = lookupOf({ 'cdn.shop.test': [PUBLIC] })
    const cases: Array<{ type: string | undefined; stored: boolean }> = [
      { type: undefined, stored: false },
      { type: 'text/html', stored: false },
      { type: 'image/svg+xml', stored: false },
      { type: 'application/octet-stream', stored: false },
      { type: 'image/png', stored: true },
      { type: 'image/webp; charset=binary', stored: true },
    ]
    const routes: Record<string, Route> = {}
    cases.forEach((c, i) => (routes[`https://cdn.shop.test/${i}`] = image(c.type)))
    web(routes)
    const { storage, puts } = recordingStorage()

    const outcomes = []
    for (let i = 0; i < cases.length; i++) {
      const before = puts.length
      const result = await downloadImage(`https://cdn.shop.test/${i}`, '', storage, 'products/t', {
        lookup,
      })
      outcomes.push({ stored: result !== null && puts.length === before + 1 })
    }

    expect(outcomes).toEqual(cases.map((c) => ({ stored: c.stored })))
    expect(puts.map((p) => p.contentType)).toEqual(['image/png', 'image/webp'])
  })
})
