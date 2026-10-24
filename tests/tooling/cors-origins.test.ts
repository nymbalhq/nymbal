import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

// AC-5: the three E2E store configs read their CORS origins from NYMBAL_CORS_ORIGINS, so an API whose storefronts
// moved to another stack slot accepts them. Each config is loaded in a child process (it reads the environment when
// imported) and parsed by @nymbalhq/config's schema, as `nymbal dev` would see it.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCHEMA_URL = pathToFileURL(join(REPO, 'node_modules/@nymbalhq/config/dist/index.js')).href

const PRINT_ORIGINS = `Promise.all([import(process.env.NYMBAL_TEST_SCHEMA_URL), import(process.env.NYMBAL_TEST_CONFIG_URL)])
  .then(([c, m]) => c.nymbalConfigSchema.parse(m.default).http.cors.allowedOrigins)
  .then(
    (origins) => process.stdout.write('\\n' + JSON.stringify(origins) + '\\n'),
    (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
  )`

/** Each E2E store config and the origins it allows today, with NYMBAL_CORS_ORIGINS unset. */
const CONFIGS = [
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

async function allowedOrigins(path: string, cors: string | undefined): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NYMBAL_CORS_ORIGINS
  const { stdout } = await exec(TSX, ['--eval', PRINT_ORIGINS], {
    cwd: REPO,
    env: {
      ...env,
      ...(cors === undefined ? {} : { NYMBAL_CORS_ORIGINS: cors }),
      NYMBAL_TEST_SCHEMA_URL: SCHEMA_URL,
      NYMBAL_TEST_CONFIG_URL: pathToFileURL(join(REPO, path)).href,
    },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null')
}

const loaded = new Map<string, unknown>()

beforeAll(async () => {
  const runs = CONFIGS.flatMap(({ path }) => [
    { key: `${path} moved`, path, cors: MOVED },
    { key: `${path} unset`, path, cors: undefined },
  ])
  const results = await Promise.all(runs.map(({ path, cors }) => allowedOrigins(path, cors)))
  runs.forEach(({ key }, i) => loaded.set(key, results[i]))
}, 60_000)

describe('AC-5: each E2E store config takes its CORS origins from NYMBAL_CORS_ORIGINS', () => {
  it.each(CONFIGS)(
    'AC-5: $path with NYMBAL_CORS_ORIGINS=http://localhost:4521,http://localhost:3200 allows exactly those origins',
    ({ path }) => {
      expect(loaded.get(`${path} moved`)).toEqual(MOVED.split(','))
    },
  )

  it.each(CONFIGS)(
    "AC-5: $path with NYMBAL_CORS_ORIGINS unset allows today's origins",
    ({ path, today }) => {
      const origins = loaded.get(`${path} unset`)
      expect(Array.isArray(origins) ? [...(origins as string[])].sort() : origins).toEqual(
        [...today].sort(),
      )
    },
  )
})
