import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Acceptance check for P1-07 AC-11, run by scripts/scaffold-clean.sh (and the CI job scaffold-clean) after it has
// scaffolded `shop` with `npx create-nymbal-app shop --template <t> --yes` against a local registry, outside the
// checkout, and started `npx nymbal dev` there. It is the vitest project `scaffold-clean`, left out of `pnpm test`.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_STORE_URL     the storefront `nymbal dev` serves
//   NYMBAL_API_URL       the API it serves (default http://localhost:3001, the generated config's http.port)

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL = process.env['NYMBAL_STORE_URL']
if (!SCAFFOLD_DIR || !STORE_URL) {
  throw new Error(
    'P1-07 AC-11 needs NYMBAL_SCAFFOLD_DIR (the scaffolded project) and NYMBAL_STORE_URL (its running storefront). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which scaffolds, starts `nymbal dev` and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const API_URL = process.env['NYMBAL_API_URL'] ?? 'http://localhost:3001'

const LOCKFILE: Record<string, string[]> = {
  npm: ['package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
}

const address = {
  firstName: 'Clean',
  lastName: 'Machine',
  addressLine1: '1 Scaffold Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

interface Manifest {
  version?: string
  packageManager?: string
  dependencies?: Record<string, string>
}
interface ProductDoc {
  slug: string
  name: string
  variants?: Array<{ id: string; stock: number }>
}

const isNymbal = (name: string): boolean => name === 'nymbal' || name.startsWith('@nymbalhq/')
const manifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest

/** A tiny cookie-carrying client for the API: the cart cookie, and a double-submit CSRF token the config demands. */
function apiClient() {
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])
  return async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(new URL(path, API_URL), {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';')
      const eq = pair!.indexOf('=')
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim())
    }
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as { data?: T }) : {}
    return { status: res.status, data: parsed.data as T }
  }
}

/** name -> every distinct version of that Nymbal package installed anywhere under node_modules (npm, pnpm or yarn). */
function installedNymbalVersions(root: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  const visitPackage = (pkgDir: string): void => {
    const path = join(pkgDir, 'package.json')
    if (!existsSync(path)) return
    const m = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string }
    if (m.name && m.version && isNymbal(m.name)) {
      if (!found.has(m.name)) found.set(m.name, new Set())
      found.get(m.name)!.add(m.version)
    }
    const nested = join(pkgDir, 'node_modules')
    if (existsSync(nested)) visitNodeModules(nested)
  }
  const visitNodeModules = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (lstatSync(full).isSymbolicLink()) continue // pnpm links; the real copy lives under .pnpm
      if (entry === '.pnpm') {
        for (const id of readdirSync(full)) {
          const inner = join(full, id, 'node_modules')
          if (existsSync(inner)) visitNodeModules(inner)
        }
      } else if (entry.startsWith('@')) {
        for (const name of readdirSync(full)) {
          const scoped = join(full, name)
          if (!lstatSync(scoped).isSymbolicLink()) visitPackage(scoped)
        }
      } else if (!entry.startsWith('.')) {
        visitPackage(full)
      }
    }
  }
  visitNodeModules(join(root, 'node_modules'))
  return found
}

describe('AC-11: a clean-machine scaffold', () => {
  it('AC-11: the project has the lockfile of the package manager its package.json records', () => {
    const pm = manifest(join(DIR, 'package.json')).packageManager?.split('@')[0] ?? ''
    expect(Object.keys(LOCKFILE)).toContain(pm)
    const present = LOCKFILE[pm]!.filter((f) => existsSync(join(DIR, f)))
    expect(present.length, `${pm} lockfile in ${DIR}`).toBeGreaterThan(0)
  })

  it('AC-11: the install resolves exactly one version of every Nymbal package, the one package.json pins', () => {
    const pinned = Object.entries(manifest(join(DIR, 'package.json')).dependencies ?? {}).filter(
      ([n]) => isNymbal(n),
    )
    expect(pinned.length).toBeGreaterThan(0)
    const installed = installedNymbalVersions(DIR)
    expect(installed.size).toBeGreaterThanOrEqual(pinned.length)
    const drift = [...installed]
      .filter(([, versions]) => versions.size !== 1)
      .map(([n, v]) => `${n}: ${[...v].join(', ')}`)
    expect(drift).toEqual([])
    for (const [name, spec] of pinned)
      expect([...(installed.get(name) ?? [])], name).toEqual([spec])
  })

  it('AC-11: GET / is 200 and the listing shows a seeded product by name', async () => {
    const api = apiClient()
    const products = await api<{ items: ProductDoc[] }>('GET', '/api/products?limit=100')
    expect(products.status).toBe(200)
    const names = products.data.items.map((p) => p.name)
    expect(names.length).toBeGreaterThan(0)

    const res = await fetch(STORE_URL)
    expect(res.status).toBe(200)
    const html = await res.text()
    const escape = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    const shown = names.filter(
      (n) =>
        html.includes(n) || html.includes(escape(n)) || html.includes(n.replace(/'/g, '&#x27;')),
    )
    expect(shown.length, `none of ${names.length} seeded names in GET /`).toBeGreaterThan(0)
  })

  it('AC-11: cart, checkout and a stub finalise over the API leave the order confirmed and stock down by the quantity', async () => {
    const api = apiClient()
    const qty = 2
    const listing = await api<{ items: ProductDoc[] }>('GET', '/api/products?limit=100')
    const product = listing.data.items.find((p) => (p.variants?.[0]?.stock ?? 0) >= qty)
    expect(product, 'a seeded product with stock').toBeDefined()
    const variantId = product!.variants![0]!.id
    const stockOf = async (): Promise<number> => {
      const doc = await api<ProductDoc>('GET', `/api/products/${product!.slug}`)
      return doc.data.variants!.find((v) => v.id === variantId)!.stock
    }
    const before = await stockOf()

    const added = await api('POST', '/api/cart/items', { variantId, qty })
    expect(added.status, JSON.stringify(added.data)).toBe(200)

    const checkout = await api<{
      orderNumber: string
      paymentIntent: { id: string }
      totalMinor: number
      currency: string
    }>('POST', '/api/checkout', {
      email: `clean-machine-${randomBytes(4).toString('hex')}@nymbal.dev`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.data)).toBe(200)

    // The stub payments adapter verifies any signature; the route only needs the header (see proof-kit/payments).
    const finalised = await fetch(new URL('/api/webhooks/stripe', API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'scaffold-clean-stub' },
      body: JSON.stringify({
        id: `evt_${randomBytes(8).toString('hex')}`,
        kind: 'payment.captured',
        paymentIntentId: checkout.data.paymentIntent.id,
        amountMinor: checkout.data.totalMinor,
        currency: checkout.data.currency,
      }),
    })
    expect(finalised.status, await finalised.clone().text()).toBe(200)

    // Projections are asynchronous: poll the read side until it settles, bounded.
    await vi.waitFor(
      async () => {
        const order = await api<{ status: string }>(
          'GET',
          `/api/orders/${checkout.data.orderNumber}`,
        )
        expect(order.data?.status).toBe('confirmed')
      },
      { timeout: 15_000, interval: 250 },
    )
    await vi.waitFor(
      async () => {
        expect(await stockOf()).toBe(before - qty)
      },
      { timeout: 15_000, interval: 250 },
    )
  }, 45_000)
})
