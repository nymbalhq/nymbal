import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// AC-3: with NYMBAL_E2E_TARGET set, the Playwright config starts only that target's servers (and the API they all
// call). The config is evaluated in a child process with the environment a CI job would give it, so the env is read
// exactly as Playwright reads it, at import time.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href

const PRINT_WEB_SERVERS = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  process.stdout.write('\\n' + JSON.stringify(m.default.webServer ?? null) + '\\n')
})`

type WebServer = { command: string; url?: string; port?: number }

/** Every variable the config reads, cleared, so the parent shell cannot leak a target into the evaluation. */
const CONFIG_ENV = [
  'CI',
  'NYMBAL_E2E_TARGET',
  'NYMBAL_E2E_ADMIN',
  'NYMBAL_STOREFRONT_URL',
  'NYMBAL_ADMIN_URL',
]

async function webServers(env: Record<string, string>): Promise<WebServer[]> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT_WEB_SERVERS], {
    cwd: E2E_DIR,
    env: { ...base, ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  const last = stdout.trimEnd().split('\n').pop() ?? 'null'
  const parsed = JSON.parse(last) as WebServer | WebServer[] | null
  return parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]
}

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
    async (target) => {
      const servers = await webServers({ CI: '1', NYMBAL_E2E_TARGET: target })
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
const PRINT_ADMIN_BASE_URLS = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  const urls = (m.default.projects ?? []).filter((p) => p.name.startsWith('admin')).map((p) => p.use && p.use.baseURL)
  process.stdout.write('\\n' + JSON.stringify(urls) + '\\n')
})`

describe('the admin E2E runs against the admin the API serves', () => {
  it.each([{ NYMBAL_E2E_TARGET: 'admin' }, { NYMBAL_E2E_ADMIN: 'true' }])(
    'AC-1: with CI=1 and %o, the webServer list is the API alone, not built, and the admin baseURL is http://localhost:3001/admin/',
    async (selector) => {
      const servers = await webServers({ CI: '1', ...selector })
      expect(servers.map(kindsOf), JSON.stringify(servers.map((s) => s.command))).toEqual([['api']])
      for (const server of servers) expect(server.command).not.toMatch(BUILD)

      const base: NodeJS.ProcessEnv = { ...process.env }
      for (const key of CONFIG_ENV) delete base[key]
      const { stdout } = await exec(TSX, ['--eval', PRINT_ADMIN_BASE_URLS], {
        cwd: E2E_DIR,
        env: { ...base, CI: '1', ...selector, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
      })
      const urls = JSON.parse(stdout.trimEnd().split('\n').pop() ?? '[]') as string[]
      expect(urls.length).toBeGreaterThan(0)
      const api = servers[0]!.url ?? ''
      for (const url of urls) {
        expect(new URL(url).origin).toBe(new URL(api).origin)
        expect(new URL(url).pathname).toBe('/admin/')
      }
    },
  )
})

// AC-10: an unknown NYMBAL_E2E_TARGET makes the config throw, naming the allowed targets. The evaluation prints only
// the error's message, so a name in a stack frame or a code frame cannot satisfy the assertion.
const PRINT_OUTCOME = `import(process.env.NYMBAL_TEST_CONFIG_URL).then(
  (m) => process.stdout.write('\\n' + JSON.stringify({ webServer: m.default.webServer ?? null }) + '\\n'),
  (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
)`

async function outcome(
  env: Record<string, string>,
): Promise<{ error?: string; webServer?: unknown }> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT_OUTCOME], {
    cwd: E2E_DIR,
    env: { ...base, ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as {
    error?: string
    webServer?: unknown
  }
}

const ALLOWED_TARGETS = ['astro', 'nextjs', 'admin']

describe('AC-10: an unknown NYMBAL_E2E_TARGET makes the Playwright config throw', () => {
  it.each(['astr0', 'Astro', 'next', 'astro-mobile'])(
    'AC-10: with CI=1 and NYMBAL_E2E_TARGET=%s, evaluating the config throws naming every allowed target',
    async (typo) => {
      const result = await outcome({ CI: '1', NYMBAL_E2E_TARGET: typo })
      const booted = ((result.webServer ?? []) as WebServer[]).map((s) => s.command)
      expect(result.error, `no error; it would boot: ${booted.join(' | ')}`).toBeDefined()
      const unnamed = ALLOWED_TARGETS.filter((t) => !(result.error ?? '').includes(t))
      expect(unnamed, result.error).toEqual([])
    },
  )
})
