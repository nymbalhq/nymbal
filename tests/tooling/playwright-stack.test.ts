import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ExpectedBlock, expectedBlock, PORT_FIELDS, type PortField } from './stack-table'

// The E2E configuration, each config evaluated once in a child process with the environment a CI job or a gate:full
// E2E step gives it, so the environment is read exactly as Playwright and `nymbal dev` read it, at import time:
// - AC-3: with NYMBAL_E2E_TARGET set, the Playwright config starts only that target's servers and the API, none built;
// - AC-1: the admin target starts the API alone, and the admin projects' baseURL is the API's /admin/;
// - AC-9: the astro storefront command passes --ignore-lock after dev, the nextjs one does not;
// - AC-10: an unknown NYMBAL_E2E_TARGET makes the config throw, naming every allowed target;
// - AC-4: the Playwright config takes every port from the stack slot;
// - AC-5: each E2E store config takes its CORS origins from NYMBAL_CORS_ORIGINS.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href
const SCHEMA_URL = pathToFileURL(join(REPO, 'node_modules/@nymbalhq/config/dist/index.js')).href

// The evaluation prints only an error's message, so a name in a stack frame or a code frame cannot satisfy AC-10.
const PRINT_CONFIG = `import(process.env.NYMBAL_TEST_CONFIG_URL).then(
  (m) => {
    const config = m.default
    const projects = (config.projects ?? []).map((p) => ({ name: p.name, baseURL: p.use && p.use.baseURL }))
    const apiUrl = process.env.NYMBAL_API_URL ?? null
    process.stdout.write('\\n' + JSON.stringify({ webServer: config.webServer ?? null, projects, apiUrl }) + '\\n')
  },
  (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
)`

const PRINT_ORIGINS = `Promise.all([import(process.env.NYMBAL_TEST_SCHEMA_URL), import(process.env.NYMBAL_TEST_CONFIG_URL)])
  .then(([c, m]) => c.nymbalConfigSchema.parse(m.default).http.cors.allowedOrigins)
  .then(
    (origins) => process.stdout.write('\\n' + JSON.stringify(origins) + '\\n'),
    (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
  )`

type WebServer = { command: string; url?: string; port?: number; env?: Record<string, string> }
type Evaluated = {
  error?: string
  webServer?: WebServer | WebServer[] | null
  projects?: { name: string; baseURL?: string }[]
  apiUrl?: string | null
}

/** Every variable the configs read, cleared, so the shell that runs the tests cannot leak a value into them. */
const CONFIG_ENV = [
  'CI',
  'NYMBAL_E2E_TARGET',
  'NYMBAL_E2E_ADMIN',
  'NYMBAL_STOREFRONT_URL',
  'NYMBAL_ADMIN_URL',
  'NYMBAL_STACK_SLOT',
  'NYMBAL_API_URL',
  'NYMBAL_CORS_ORIGINS',
  'NYMBAL_TEST_MAILPIT_SMTP',
  'NYMBAL_TEST_MAILPIT_URL',
]

function cleanEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  return base
}

async function evaluate(env: Record<string, string>): Promise<Evaluated> {
  const { stdout } = await exec(TSX, ['--eval', PRINT_CONFIG], {
    cwd: E2E_DIR,
    env: { ...cleanEnv(), ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as Evaluated
}

async function allowedOrigins(path: string, cors: string | undefined): Promise<unknown> {
  const { stdout } = await exec(TSX, ['--eval', PRINT_ORIGINS], {
    cwd: REPO,
    env: {
      ...cleanEnv(),
      ...(cors === undefined ? {} : { NYMBAL_CORS_ORIGINS: cors }),
      NYMBAL_TEST_SCHEMA_URL: SCHEMA_URL,
      NYMBAL_TEST_CONFIG_URL: pathToFileURL(join(REPO, path)).href,
    },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null')
}

/** The stores the E2E suite runs: each API and the two storefronts that call it. */
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

/** The runs: no target (both templates), each NYMBAL_E2E_TARGET, and NYMBAL_E2E_ADMIN. */
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
const targetNamed = (name: string): Target => TARGETS.find((t) => t.name === name)!

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

const TYPOS = ['astr0', 'Astro', 'next', 'astro-mobile']
const ALLOWED_TARGETS = ['astro', 'nextjs', 'admin']

/** Each E2E store config and the origins it allows today, with NYMBAL_CORS_ORIGINS unset. */
const STORE_CONFIGS = [
  { path: 'nymbal.config.ts', today: ['http://localhost:3000', 'http://localhost:4321'] },
  {
    path: 'tests/e2e/fixtures/custom-providers/nymbal.config.ts',
    today: ['http://localhost:4331', 'http://localhost:3010'],
  },
  {
    path: 'tests/e2e/fixtures/no-search/nymbal.config.ts',
    today: ['http://localhost:4341', 'http://localhost:3020'],
  },
]
const MOVED = 'http://localhost:4521,http://localhost:3200'

const origin = (port: number): string => `http://localhost:${port}`

const SLOTS = [2, 0]
const evaluated = new Map<string, Evaluated>()
const key = (slot: number, target: Target): string => `${slot}/${target.name}`
const typoKey = (typo: string): string => `typo/${typo}`
/** CI's Mailpit service SMTP address, outside every slot block. */
const CI_MAILPIT_SMTP = 'localhost:12525'
const smtpKey = (target: Target): string => `smtp/${target.name}`
const CUSTOM_TARGET_NAMES = ['astro-custom', 'nextjs-custom']
const origins = new Map<string, unknown>()

beforeAll(async () => {
  const runs = [
    ...SLOTS.flatMap((slot) =>
      TARGETS.map((target) => ({
        key: key(slot, target),
        env: { CI: '1', NYMBAL_STACK_SLOT: String(slot), ...target.env },
      })),
    ),
    ...TYPOS.map((typo) => ({
      key: typoKey(typo),
      env: { CI: '1', NYMBAL_STACK_SLOT: '0', NYMBAL_E2E_TARGET: typo },
    })),
    ...CUSTOM_TARGET_NAMES.map((name) => ({
      key: smtpKey(targetNamed(name)),
      env: {
        CI: '1',
        NYMBAL_STACK_SLOT: '2',
        NYMBAL_TEST_MAILPIT_SMTP: CI_MAILPIT_SMTP,
        ...targetNamed(name).env,
      },
    })),
  ]
  const stores = STORE_CONFIGS.flatMap(({ path }) => [
    { key: `${path} moved`, path, cors: MOVED },
    { key: `${path} unset`, path, cors: undefined },
  ])
  const [configs, allowed] = await Promise.all([
    Promise.all(runs.map((run) => evaluate(run.env))),
    Promise.all(stores.map(({ path, cors }) => allowedOrigins(path, cors))),
  ])
  runs.forEach((run, i) => evaluated.set(run.key, configs[i]!))
  stores.forEach((store, i) => origins.set(store.key, allowed[i]))
}, 120_000)

function serversOf(slot: number, target: Target): WebServer[] {
  const result = evaluated.get(key(slot, target)) ?? {}
  expect(result.error, result.error).toBeUndefined()
  const servers = result.webServer ?? []
  return Array.isArray(servers) ? servers : [servers]
}

const isApi = (server: WebServer): boolean => /--api-only\b/.test(server.command)

/** Which server an entry is, from its command, URL and port. Package names may carry the @nymbalhq scope. */
const KINDS: Record<string, RegExp> = {
  api: /--api-only|:3001\b/,
  astro: /template-astro\b|templates\/astro\b|:4321\b/,
  nextjs: /template-nextjs\b|templates\/nextjs\b|:3000\b/,
  admin: /@nymbal(?:hq)?\/admin\b|apps\/admin\b|:5174\b/,
}

function kindsOf(server: WebServer): string[] {
  const text = `${server.command} ${server.url ?? ''} ${server.port === undefined ? '' : `:${server.port}`}`
  return Object.keys(KINDS).filter((kind) => KINDS[kind]!.test(text))
}

/** A build in a server command: the E2E jobs serve the downloaded artefact, they do not rebuild it (AC-4). */
const BUILD =
  /\bpnpm\s+(?:(?:-r|--recursive|(?:--filter|-F)(?:=|\s+)\S+)\s+)*(?:run\s+)?build(?::templates)?\b|\b(?:vite|astro|next|tsup)\s+build\b/

describe('AC-3: NYMBAL_E2E_TARGET starts only that target and the API', () => {
  it.each(['astro', 'nextjs'])(
    'AC-3: with CI=1 and NYMBAL_E2E_TARGET=%s, the webServer list is the API and that target, once each, none built',
    (target) => {
      const servers = serversOf(0, targetNamed(target))
      const kinds = servers.map((server) => {
        const kind = kindsOf(server)
        expect(kind, `${server.command} (${server.url ?? server.port})`).toHaveLength(1)
        return kind[0]
      })
      expect([...kinds].sort(), JSON.stringify(servers.map((s) => s.command))).toEqual(
        ['api', target].sort(),
      )
      for (const server of servers) expect(server.command).not.toMatch(BUILD)
    },
  )
})

// AC-1: the admin is served by `nymbal dev --api-only` at <api>/admin/, so the admin target starts the API alone (no
// Vite server), and both admin projects default their baseURL to the API's /admin/.
describe('the admin E2E runs against the admin the API serves', () => {
  it.each(['admin', 'NYMBAL_E2E_ADMIN=true'])(
    'AC-1: with CI=1 and %s, the webServer list is the API alone, not built, and the admin baseURL is the API’s /admin/',
    (name) => {
      const servers = serversOf(0, targetNamed(name))
      expect(servers.map(kindsOf), JSON.stringify(servers.map((s) => s.command))).toEqual([['api']])
      for (const server of servers) expect(server.command).not.toMatch(BUILD)

      const urls = (evaluated.get(key(0, targetNamed(name)))?.projects ?? [])
        .filter((p) => p.name.startsWith('admin'))
        .map((p) => p.baseURL ?? '')
      expect(urls.length).toBeGreaterThan(0)
      const api = servers[0]!.url ?? ''
      for (const url of urls) {
        expect(new URL(url).origin).toBe(new URL(api).origin)
        expect(new URL(url).pathname).toBe('/admin/')
      }
    },
  )
})

describe('AC-9: the Playwright astro webServer keeps astro dev in the foreground under an agent', () => {
  it('AC-9: with CI=1 and NYMBAL_E2E_TARGET=astro, the astro command passes --ignore-lock after dev; the nextjs command does not', () => {
    const storefront = (name: string): string[] => {
      const servers = serversOf(0, targetNamed(name)).filter((s) => !isApi(s))
      expect(servers, JSON.stringify(servers)).toHaveLength(1)
      return servers[0]!.command.split(/\s+/)
    }
    const astro = storefront('astro')
    const nextjs = storefront('nextjs')

    expect(astro, astro.join(' ')).toContain('--ignore-lock')
    expect(astro.indexOf('--ignore-lock')).toBeGreaterThan(astro.indexOf('dev'))
    expect(nextjs, nextjs.join(' ')).not.toContain('--ignore-lock')
  })
})

describe('AC-10: an unknown NYMBAL_E2E_TARGET makes the Playwright config throw', () => {
  it.each(TYPOS)(
    'AC-10: with CI=1 and NYMBAL_E2E_TARGET=%s, evaluating the config throws naming every allowed target',
    (typo) => {
      const result = evaluated.get(typoKey(typo)) ?? {}
      const servers = result.webServer ?? []
      const booted = (Array.isArray(servers) ? servers : [servers]).map((s) => s.command)
      expect(result.error, `no error; it would boot: ${booted.join(' | ')}`).toBeDefined()
      const unnamed = ALLOWED_TARGETS.filter((t) => !(result.error ?? '').includes(t))
      expect(unnamed, result.error).toEqual([])
    },
  )
})

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
      const listed = (api[0]!.env?.NYMBAL_CORS_ORIGINS ?? '').split(',').map((o) => o.trim())
      expect(listed.sort()).toEqual(
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

// AC-13: the custom-providers store sends its mail by SMTP to the slot's Mailpit, so a worktree's custom store never
// mails slot 0's; CI's Mailpit service, named by NYMBAL_TEST_MAILPIT_SMTP, wins when it is set.
describe.each(SLOTS)('AC-13: the custom store’s API mails its slot’s Mailpit (slot %i)', (slot) => {
  const block: ExpectedBlock = expectedBlock(slot)

  it.each(CUSTOM_TARGET_NAMES)(
    'AC-13: %s: the API server’s NYMBAL_E2E_SMTP_PORT is the block’s mailpitSmtp, a port inside the block',
    (name) => {
      const api = serversOf(slot, targetNamed(name)).filter(isApi)
      expect(api.length).toBe(1)
      const port = api[0]!.env?.NYMBAL_E2E_SMTP_PORT
      expect(port).toBe(String(block.mailpitSmtp))
      expect(PORT_FIELDS.map((f) => String(block[f]))).toContain(port)
    },
  )
})

describe('AC-13: NYMBAL_TEST_MAILPIT_SMTP names the custom store’s SMTP port when it is set', () => {
  it.each(CUSTOM_TARGET_NAMES)(
    'AC-13: %s with NYMBAL_TEST_MAILPIT_SMTP=localhost:12525: the API server’s NYMBAL_E2E_SMTP_PORT is 12525',
    (name) => {
      const result = evaluated.get(smtpKey(targetNamed(name))) ?? {}
      expect(result.error, result.error).toBeUndefined()
      const servers = result.webServer ?? []
      const api = (Array.isArray(servers) ? servers : [servers]).filter(isApi)
      expect(api.map((s) => s.env?.NYMBAL_E2E_SMTP_PORT)).toEqual([
        new URL(`smtp://${CI_MAILPIT_SMTP}`).port,
      ])
    },
  )
})

describe('AC-5: each E2E store config takes its CORS origins from NYMBAL_CORS_ORIGINS', () => {
  it.each(STORE_CONFIGS)(
    'AC-5: $path with NYMBAL_CORS_ORIGINS=http://localhost:4521,http://localhost:3200 allows exactly those origins',
    ({ path }) => {
      expect(origins.get(`${path} moved`)).toEqual(MOVED.split(','))
    },
  )

  it.each(STORE_CONFIGS)(
    "AC-5: $path with NYMBAL_CORS_ORIGINS unset allows today's origins",
    ({ path, today }) => {
      const allowed = origins.get(`${path} unset`)
      expect(Array.isArray(allowed) ? [...(allowed as string[])].sort() : allowed).toEqual(
        [...today].sort(),
      )
    },
  )
})

// The custom-store projects run only the journeys tagged @capabilities: the ones whose assertions branch on what
// GET /api/capabilities reports, which is what the custom providers change. Everything else runs on the native store
// alone, so the default projects still list every tagged journey among the rest.
const PLAYWRIGHT = join(E2E_DIR, 'node_modules/.bin/playwright')
const CUSTOM_OF: Record<string, string> = { astro: 'astro-custom', nextjs: 'nextjs-custom' }

/** The tagged journeys, as `<file> <criterion>`; payment-step's AC-5 has two tests. */
const CAPABILITY_JOURNEYS = [
  'alerts.spec.ts AC-6',
  'alerts.spec.ts AC-7',
  'alerts.spec.ts AC-9',
  'alerts.spec.ts AC-10',
  'alerts.spec.ts AC-11',
  'browse-sort.spec.ts AC-4',
  'browse-sort.spec.ts AC-7',
  'browse.spec.ts AC-3',
  'payment-step.spec.ts AC-5',
  'payment-step.spec.ts AC-5',
  'search-pages.spec.ts AC-8',
  'search.spec.ts AC-3',
]

type Listed = { file: string; title: string; tags: string[]; project: string }
type Suite = { file?: string; specs?: Spec[]; suites?: Suite[] }
type Spec = { title: string; tags?: string[]; tests?: Array<{ projectName: string }> }

/** `playwright test --list` over the named projects, one row per test per project. */
async function listTests(projects: string[]): Promise<Listed[]> {
  const { stdout } = await exec(
    PLAYWRIGHT,
    ['test', '--list', '--reporter=json', ...projects.flatMap((p) => ['--project', p])],
    {
      cwd: E2E_DIR,
      env: { ...cleanEnv(), CI: '1', NYMBAL_STACK_SLOT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { suites?: Suite[] }
  const rows: Listed[] = []
  const walk = (suite: Suite, file: string | undefined): void => {
    const own = file ?? suite.file
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        rows.push({
          file: own ?? '?',
          title: spec.title,
          tags: spec.tags ?? [],
          project: test.projectName,
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, own)
  }
  for (const suite of report.suites ?? []) walk(suite, undefined)
  return rows
}

const journeyKey = (row: Listed): string =>
  `${row.file} ${/^AC-\d+/.exec(row.title)?.[0] ?? row.title}`

describe('the custom-store projects run only the journeys tagged @capabilities', () => {
  const listed = new Map<string, Listed[]>()

  beforeAll(async () => {
    const projects = [...Object.keys(CUSTOM_OF), ...Object.values(CUSTOM_OF)]
    for (const row of await listTests(projects)) {
      listed.set(row.project, [...(listed.get(row.project) ?? []), row])
    }
  }, 60_000)

  it.each(Object.values(CUSTOM_OF))('%s lists exactly the tagged journeys', (project) => {
    const rows = listed.get(project) ?? []
    expect(rows.map(journeyKey).sort()).toEqual([...CAPABILITY_JOURNEYS].sort())
    expect(rows.filter((row) => !row.tags.includes('capabilities'))).toEqual([])
  })

  it.each(Object.keys(CUSTOM_OF))(
    '%s still lists every tagged journey, among the untagged ones',
    (project) => {
      const rows = listed.get(project) ?? []
      const tagged = rows.filter((row) => row.tags.includes('capabilities'))
      expect(tagged.map(journeyKey).sort()).toEqual(
        (listed.get(CUSTOM_OF[project]!) ?? []).map(journeyKey).sort(),
      )
      expect(rows.length).toBeGreaterThan(tagged.length)
    },
  )
})
