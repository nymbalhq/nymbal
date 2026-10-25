import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../config/src/index.js'
import { scaffold } from '../src/index.js'

// AC-5: a new store's nymbal.config.ts names its storefront's URL, the chosen template's dev origin, so the
// order-placed email links to the order page from the first run. Read through loadConfig, as `nymbal dev` reads it.
// The scaffold is read from scaffold/templates, so run `pnpm build` first.

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = resolve(HERE, '..', '..')

/** Each template's dev server origin: Astro's default port and Next's. */
const DEV_ORIGIN = { astro: 'http://localhost:4321', nextjs: 'http://localhost:3000' } as const

/** The origin of a URL: its scheme, host and port, with no path and no trailing slash. */
const originOf = (url: string): string => (url === '' ? '' : new URL(url).origin)

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

// The rendered config reads NYMBAL_STOREFRONT_URL first; the shell running the tests must not choose the URL.
const ENV = 'NYMBAL_STOREFRONT_URL'
let saved: string | undefined
beforeEach(() => {
  saved = process.env[ENV]
  delete process.env[ENV]
})
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

async function scaffolded(template: keyof typeof DEV_ORIGIN): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), `scaffold-url-${template}-`)))
  scratch.push(root)
  const dir = join(root, 'shop')
  await scaffold(dir, {
    name: 'Shop',
    directory: 'shop',
    currency: 'GBP',
    template,
    seedDemo: false,
  })
  // The config imports @nymbalhq/config; link the workspace package in as an install would.
  await mkdir(join(dir, 'node_modules', '@nymbalhq'), { recursive: true })
  if (!existsSync(join(dir, 'node_modules', '@nymbalhq', 'config'))) {
    await symlink(join(PACKAGES, 'config'), join(dir, 'node_modules', '@nymbalhq', 'config'), 'dir')
  }
  return dir
}

describe('AC-5: the scaffolded config names the storefront URL', () => {
  for (const template of ['astro', 'nextjs'] as const) {
    it(`AC-5: ${template}'s generated nymbal.config.ts, loaded by loadConfig, has store.url ${DEV_ORIGIN[template]}, an origin with no trailing slash`, async () => {
      const { config } = await loadConfig(await scaffolded(template))
      const url = config.store.url ?? ''

      expect(url).toBe(DEV_ORIGIN[template])
      expect(url, 'an origin, nothing after it').toBe(originOf(url))
    })
  }
})
