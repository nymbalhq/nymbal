import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ExpectedBlock, expectedBlock, PORT_FIELDS, type PortField } from './stack-table'

// AC-4: the Playwright config takes every port from the stack slot. The config is evaluated in a child process with
// the environment a gate:full E2E step gives it (CI=1, a target, NYMBAL_STACK_SLOT), as
// tests/tooling/playwright-target.test.ts does, so the environment is read exactly as Playwright reads it.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href

const PRINT_CONFIG = `import(process.env.NYMBAL_TEST_CONFIG_URL).then(
  (m) => {
    const config = m.default
    const projects = (config.projects ?? []).map((p) => ({ name: p.name, baseURL: p.use && p.use.baseURL }))
    const apiUrl = process.env.NYMBAL_API_URL ?? null
    process.stdout.write('\\n' + JSON.stringify({ webServer: config.webServer ?? null, projects, apiUrl }) + '\\n')
  },
  (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
)`

type WebServer = { command: string; url?: string; env?: Record<string, string> }
type Evaluated = {
  error?: string
  webServer?: WebServer | WebServer[] | null
  projects?: { name: string; baseURL?: string }[]
  apiUrl?: string | null
}

/** Every variable the config reads, cleared, so the shell that runs the tests cannot leak a value into the evaluation. */
const CONFIG_ENV = [
  'CI',
  'NYMBAL_E2E_TARGET',
  'NYMBAL_E2E_ADMIN',
  'NYMBAL_STOREFRONT_URL',
  'NYMBAL_ADMIN_URL',
  'NYMBAL_STACK_SLOT',
  'NYMBAL_API_URL',
  'NYMBAL_CORS_ORIGINS',
]

async function evaluate(env: Record<string, string>): Promise<Evaluated> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT_CONFIG], {
    cwd: E2E_DIR,
    env: { ...base, ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as Evaluated
}

/** The three stores the E2E suite runs: each API and the two storefronts that call it. */
const STORES = {
  native: { api: 'api', storefronts: ['astro', 'nextjs'] },
  custom: { api: 'customApi', storefronts: ['astroCustom', 'nextjsCustom'] },
  nosearch: { api: 'noSearchApi', storefronts: ['astroNoSearch', 'nextjsNoSearch'] },
  // The project-elements fixture.
  override: { api: 'overrideApi', storefronts: ['astroOverride', 'nextjsOverride'] },
} as const satisfies Record<string, { api: PortField; storefronts: PortField[] }>

type Target = {
  name: string
  env: Record<string, string>
  store: keyof typeof STORES
  storefronts: PortField[]
}

/** The nine runs: no target (both templates), each NYMBAL_E2E_TARGET, and NYMBAL_E2E_ADMIN. */
const TARGETS: Target[] = [
  { name: 'no target', env: {}, store: 'native', storefronts: ['astro', 'nextjs'] },
  { name: 'astro', env: { NYMBAL_E2E_TARGET: 'astro' }, store: 'native', storefronts: ['astro'] },
  {
    name: 'nextjs',
    env: { NYMBAL_E2E_TARGET: 'nextjs' },
    store: 'native',
    storefronts: ['nextjs'],
  },
  { name: 'admin', env: { NYMBAL_E2E_TARGET: 'admin' }, store: 'native', storefronts: [] },
  {
    name: 'NYMBAL_E2E_ADMIN=true',
    env: { NYMBAL_E2E_ADMIN: 'true' },
    store: 'native',
    storefronts: [],
  },
  {
    name: 'astro-custom',
    env: { NYMBAL_E2E_TARGET: 'astro-custom' },
    store: 'custom',
    storefronts: ['astroCustom'],
  },
  {
    name: 'nextjs-custom',
    env: { NYMBAL_E2E_TARGET: 'nextjs-custom' },
    store: 'custom',
    storefronts: ['nextjsCustom'],
  },
  {
    name: 'astro-nosearch',
    env: { NYMBAL_E2E_TARGET: 'astro-nosearch' },
    store: 'nosearch',
    storefronts: ['astroNoSearch'],
  },
  {
    name: 'nextjs-nosearch',
    env: { NYMBAL_E2E_TARGET: 'nextjs-nosearch' },
    store: 'nosearch',
    storefronts: ['nextjsNoSearch'],
  },
  {
    name: 'astro-override',
    env: { NYMBAL_E2E_TARGET: 'astro-override' },
    store: 'override',
    storefronts: ['astroOverride'],
  },
  {
    name: 'nextjs-override',
    env: { NYMBAL_E2E_TARGET: 'nextjs-override' },
    store: 'override',
    storefronts: ['nextjsOverride'],
  },
]

/** Each Playwright project's baseURL, by the block field it is served on (`admin` is the API's /admin/). */
const PROJECT_FIELDS: Record<string, PortField | 'admin'> = {
  astro: 'astro',
  nextjs: 'nextjs',
  'astro-custom': 'astroCustom',
  'nextjs-custom': 'nextjsCustom',
  'astro-nosearch': 'astroNoSearch',
  'nextjs-nosearch': 'nextjsNoSearch',
  'astro-override': 'astroOverride',
  'nextjs-override': 'nextjsOverride',
  'astro-mobile': 'astro',
  'nextjs-mobile': 'nextjs',
  admin: 'admin',
  'admin-mobile': 'admin',
}

const origin = (port: number): string => `http://localhost:${port}`

const SLOTS = [2, 0]
const evaluated = new Map<string, Evaluated>()
const key = (slot: number, target: Target): string => `${slot}/${target.name}`

beforeAll(async () => {
  const runs = SLOTS.flatMap((slot) => TARGETS.map((target) => ({ slot, target })))
  const results = await Promise.all(
    runs.map(({ slot, target }) =>
      evaluate({ CI: '1', NYMBAL_STACK_SLOT: String(slot), ...target.env }),
    ),
  )
  runs.forEach(({ slot, target }, i) => evaluated.set(key(slot, target), results[i]!))
}, 120_000)

function serversOf(slot: number, target: Target): WebServer[] {
  const result = evaluated.get(key(slot, target)) ?? {}
  expect(result.error, result.error).toBeUndefined()
  const servers = result.webServer ?? []
  return Array.isArray(servers) ? servers : [servers]
}

const isApi = (server: WebServer): boolean => /--api-only\b/.test(server.command)

/** The port a storefront command binds: its --port/-p, or 3000 for the Next.js template's own `dev` script. */
function boundPort(command: string): string | undefined {
  const flag = /(?:--port|-p)[=\s]+(\d+)/.exec(command)?.[1]
  return flag ?? (/template-nextjs dev\b/.test(command) ? '3000' : undefined)
}

describe.each(SLOTS)('AC-4: the Playwright config in stack slot %i', (slot) => {
  const block: ExpectedBlock = expectedBlock(slot)

  it.each(TARGETS)(
    'AC-4 (a): $name: every webServer url and storefront port is the block’s, and no URL names a port outside it',
    (target) => {
      const servers = serversOf(slot, target)
      const store = STORES[target.store]
      const api = servers.filter(isApi)
      expect(api.map((s) => s.url)).toEqual([`${origin(block[store.api])}/health`])
      const storefronts = servers.filter((s) => !isApi(s))
      expect(storefronts.map((s) => s.url).sort()).toEqual(
        target.storefronts.map((f) => origin(block[f])).sort(),
      )
      expect(storefronts.map((s) => boundPort(s.command))).toEqual(
        storefronts.map((s) => new URL(s.url ?? '').port),
      )
      // A storefront calls its own store's API (NYMBAL_API_URL and the framework's public copy of it).
      const apiUrls = storefronts.flatMap((s) =>
        Object.entries(s.env ?? {})
          .filter(([name]) => name.endsWith('API_URL'))
          .map(([, value]) => value),
      )
      expect(apiUrls.length).toBeGreaterThanOrEqual(storefronts.length)
      expect(new Set(apiUrls)).toEqual(
        new Set(storefronts.length === 0 ? [] : [origin(block[store.api])]),
      )
      const allowed = new Set(PORT_FIELDS.map((f) => String(block[f])))
      const result = evaluated.get(key(slot, target))
      const text = JSON.stringify([result?.webServer, result?.projects])
      const strays = [...text.matchAll(/localhost:(\d+)/g)]
        .map((m) => m[1]!)
        .filter((port) => !allowed.has(port))
      expect([...new Set(strays)]).toEqual([])
    },
  )

  it.each(TARGETS)(
    'AC-4 (b): $name: the API server command ends --port <its block port>',
    (target) => {
      const api = serversOf(slot, target).filter(isApi)
      expect(api.length).toBe(1)
      expect(/--port[=\s]+(\d+)$/.exec(api[0]!.command.trimEnd())?.[1]).toBe(
        String(block[STORES[target.store].api]),
      )
    },
  )

  it.each(TARGETS)(
    'AC-4 (c): $name: the API server’s NYMBAL_CORS_ORIGINS is its two storefronts’ origins',
    (target) => {
      const api = serversOf(slot, target).filter(isApi)
      expect(api.length).toBe(1)
      const origins = (api[0]!.env?.NYMBAL_CORS_ORIGINS ?? '').split(',').map((o) => o.trim())
      expect(origins.sort()).toEqual(
        STORES[target.store].storefronts.map((f) => origin(block[f])).sort(),
      )
    },
  )

  it.each(TARGETS)('AC-4 (d): $name: each project’s baseURL is the block’s', (target) => {
    const projects = evaluated.get(key(slot, target))?.projects ?? []
    expect(Object.fromEntries(projects.map((p) => [p.name, p.baseURL]))).toEqual(
      Object.fromEntries(
        Object.entries(PROJECT_FIELDS).map(([name, field]) => [
          name,
          field === 'admin' ? `${origin(block.api)}/admin/` : origin(block[field]),
        ]),
      ),
    )
  })

  it.each(TARGETS)(
    'AC-4 (e): $name: process.env.NYMBAL_API_URL after import is the run’s API',
    (target) => {
      expect(evaluated.get(key(slot, target))?.apiUrl).toBe(origin(block[STORES[target.store].api]))
    },
  )
})
