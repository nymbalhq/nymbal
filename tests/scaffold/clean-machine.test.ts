import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// AC-11, run by scripts/scaffold-clean.sh (and the CI job scaffold-clean) after it has scaffolded `shop` with
// `npx create-nymbal-app shop --template <t> --yes` against a local registry, outside the checkout, and started
// `npx nymbal dev` there. It is the vitest project `scaffold-clean`, left out of `pnpm test`.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_STORE_URL     the storefront `nymbal dev` serves
//   NYMBAL_API_URL       the API it serves (default http://localhost:3001, the generated config's http.port)

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL = process.env['NYMBAL_STORE_URL']
if (!SCAFFOLD_DIR || !STORE_URL) {
  throw new Error(
    'AC-11 needs NYMBAL_SCAFFOLD_DIR (the scaffolded project) and NYMBAL_STORE_URL (its running storefront). ' +
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

  // The stub pays inline, so the checkout alone confirms; no webhook call.
  it('AC-11: cart and checkout over the API, with no webhook call, leave the order confirmed and stock down by the quantity', async () => {
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

    const checkout = await api<{ orderNumber: string }>('POST', '/api/checkout', {
      email: `clean-machine-${randomBytes(4).toString('hex')}@nymbal.dev`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.data)).toBe(200)

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

// AC-13: the published admin, served by the scaffolded project's `nymbal dev` at <api>/admin/, and the admin account
// the seed created from the credentials create-app wrote to the project's `.env`.

function dotEnvValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(source)
  return match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
}

describe('AC-13: the clean-machine admin', () => {
  it('AC-13: GET <api>/admin/ is HTML that loads a script under /admin/assets/, and that script answers 200 text/javascript', async () => {
    const page = await fetch(new URL('/admin/', API_URL))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type') ?? '').toMatch(/^text\/html/)
    const html = await page.text()
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!)
    const admin = scripts.filter((src) =>
      new URL(src, new URL('/admin/', API_URL)).pathname.startsWith('/admin/assets/'),
    )
    expect(admin.length, `scripts in /admin/: ${JSON.stringify(scripts)}`).toBeGreaterThan(0)
    for (const src of admin) {
      const script = await fetch(new URL(src, new URL('/admin/', API_URL)))
      expect(script.status, src).toBe(200)
      expect(script.headers.get('content-type') ?? '', src).toMatch(/^text\/javascript/)
      expect((await script.text()).length, src).toBeGreaterThan(0)
    }
  })

  it("AC-13: POST /api/auth/login with the credentials in the project's .env returns a customer whose roles include admin", async () => {
    const env = readFileSync(join(DIR, '.env'), 'utf8')
    const email = dotEnvValue(env, 'NYMBAL_ADMIN_EMAIL')
    const password = dotEnvValue(env, 'NYMBAL_ADMIN_PASSWORD')
    expect(email, 'NYMBAL_ADMIN_EMAIL in .env').toBeDefined()
    expect(password?.length ?? 0, 'NYMBAL_ADMIN_PASSWORD in .env').toBeGreaterThanOrEqual(22)

    const api = apiClient()
    const login = await api<{ customer: { email: string; roles: string[] } }>(
      'POST',
      '/api/auth/login',
      {
        email,
        password,
      },
    )
    expect(login.status, JSON.stringify(login.data)).toBe(200)
    expect(login.data.customer.email).toBe(email)
    expect(login.data.customer.roles).toContain('admin')
  })
})

// The clean-machine store installs no provider SDK, and naming a provider whose adapter package is not installed
// stops `nymbal dev` with the install line for the project's package manager (npm here: the scaffold ran through
// npx). The config half (ai `none`) is checked where it is cheapest, in packages/create-app/test. Last in the file: it
// edits nymbal.config.ts, restored in finally.

const PROVIDER_SDKS = ['stripe', '@anthropic-ai/sdk', 'nodemailer']

/** Every package name installed under the project's node_modules, nested ones and pnpm's .pnpm/<name>@<version> too. */
function installedPackageNames(root: string): Set<string> {
  const names = new Set<string>()
  const visitPackage = (pkgDir: string): void => {
    const path = join(pkgDir, 'package.json')
    if (existsSync(path)) {
      const m = JSON.parse(readFileSync(path, 'utf8')) as { name?: string }
      if (m.name) names.add(m.name)
    }
    const nested = join(pkgDir, 'node_modules')
    if (existsSync(nested)) visitNodeModules(nested)
  }
  const visitNodeModules = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (lstatSync(full).isSymbolicLink()) continue
      if (entry === '.pnpm') {
        for (const id of readdirSync(full)) {
          // `@scope+name@1.2.3(peer@x)` or `name@1.2.3`: the name is everything before the version's `@`.
          const at = id.indexOf('@', id.startsWith('@') ? 1 : 0)
          if (at > 0) names.add(id.slice(0, at).replace('+', '/'))
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
  return names
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

/** Runs a command in the project until it exits, or kills its process group after `timeoutMs`. */
function runInProject(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  const env = { ...process.env }
  // The suite runs under pnpm; npx sets the user agent of the package manager the project uses.
  for (const key of Object.keys(env)) {
    if (
      key === 'npm_config_user_agent' ||
      key === 'npm_execpath' ||
      key.startsWith('npm_lifecycle_')
    ) {
      delete env[key]
    }
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: DIR,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut, output })
    })
  })
}

describe('AC-7: a clean machine installs no provider SDK', () => {
  it('AC-7: no package directory under node_modules, .pnpm entries included, is stripe, @anthropic-ai/sdk or nodemailer', () => {
    const installed = installedPackageNames(DIR)
    expect(installed.size).toBeGreaterThan(0)
    expect(PROVIDER_SDKS.filter((sdk) => installed.has(sdk))).toEqual([])
  })

  it('AC-7: with payments.provider changed to stripe, `npx nymbal dev --api-only` on a free port exits non-zero printing `npm install @nymbalhq/adapter-stripe stripe`', async () => {
    const path = join(DIR, 'nymbal.config.ts')
    const original = readFileSync(path, 'utf8')
    const edited = original.replace(
      /payments:\s*\{\s*provider:\s*'native'\s*\}/,
      "payments: { provider: 'stripe', config: { secretKey: 'sk_test_adapters', webhookSecret: 'whsec_adapters' } }",
    )
    expect(edited, 'the scaffold config names native payments').not.toBe(original)
    try {
      writeFileSync(path, edited)
      const port = await freePort()
      const run = await runInProject(
        'npx',
        ['nymbal', 'dev', '--api-only', '--port', String(port)],
        60_000,
      )

      expect(run.timedOut, `still serving after 60 s:\n${run.output.slice(-2000)}`).toBe(false)
      expect(run.code).not.toBe(0)
      expect(run.output).toContain('npm install @nymbalhq/adapter-stripe stripe')
    } finally {
      writeFileSync(path, original)
    }
  }, 90_000)
})
