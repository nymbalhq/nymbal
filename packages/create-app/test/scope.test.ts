import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scaffold } from '../src/index.js'

// Acceptance tests for P0-04 AC-4: a fresh scaffold names @nymbalhq/* packages and the `nymbal` CLI, every one of
// which is a published workspace package (resolution checked in-workspace). Reads the synced scaffold, so run
// `pnpm build` first.

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PACKAGES_DIR = resolve(PKG_ROOT, '..')
// Built so that this file never contains the old scope literally (AC-1 scans every tracked file).
const OLD = ['@nymbal', '/'].join('')
const NEW = '@nymbalhq/'

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest
}

/** name -> version of every published package under packages/. */
async function publishedPackages(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const entry of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const m = await readManifest(join(PACKAGES_DIR, entry.name))
      if (m.name && m.version && m.private !== true) out.set(m.name, m.version)
    } catch {
      // not a package
    }
  }
  return out
}

async function textFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await textFiles(full)))
    else if (
      /\.(json|ts|tsx|mjs|js|astro|md|ya?ml|css|example)$|^\.(gitignore|env\.example)$/.test(e.name)
    )
      out.push(full)
  }
  return out
}

describe('AC-4: the scaffold emits @nymbalhq/* dependencies and the nymbal CLI', () => {
  let tmpBase: string
  let published: Map<string, string>
  const out: Record<'astro' | 'nextjs', string> = { astro: '', nextjs: '' }

  beforeAll(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'create-nymbal-app-scope-'))
    published = await publishedPackages()
    for (const template of ['astro', 'nextjs'] as const) {
      out[template] = join(tmpBase, `scope-${template}`)
      await scaffold(out[template], {
        name: 'Scope Store',
        directory: `scope-${template}`,
        currency: 'GBP',
        template,
        seedDemo: false,
        includeMobile: false,
      })
    }
  }, 60_000)

  afterAll(async () => {
    if (tmpBase) await rm(tmpBase, { recursive: true, force: true })
  })

  for (const template of ['astro', 'nextjs'] as const) {
    describe(template, () => {
      it(`AC-4: ${template} depends on \`nymbal\`, and that name is the CLI package`, async () => {
        const deps = (await readManifest(out[template])).dependencies ?? {}
        expect(Object.keys(deps)).toContain('nymbal')
        // The published package called `nymbal` is packages/cli, not some other manifest.
        const cli = join(PACKAGES_DIR, 'cli')
        expect((await readManifest(cli)).name).toBe('nymbal')
        expect(published.get('nymbal')).toBe((await readManifest(cli)).version)
      })

      it(`AC-4: every ${template} Nymbal dependency is @nymbalhq/* or nymbal and is a published workspace package`, async () => {
        const m = await readManifest(out[template])
        const deps = { ...m.dependencies, ...m.devDependencies }
        const nymbalDeps = Object.keys(deps).filter(
          (k) => k.startsWith('@nymbal') || k === 'nymbal',
        )
        const wrongScope = nymbalDeps.filter((k) => k !== 'nymbal' && !k.startsWith(NEW))
        expect(wrongScope).toEqual([])
        // A name with no published workspace package will never exist on npm.
        const unpublished = nymbalDeps.filter((k) => !published.has(k))
        expect(unpublished).toEqual([])
      })

      it(`AC-4: no ${template} output file names the old scope`, async () => {
        const offenders: string[] = []
        for (const file of await textFiles(out[template])) {
          const text = await readFile(file, 'utf8')
          text.split('\n').forEach((line, i) => {
            if (line.includes(OLD))
              offenders.push(`${relative(out[template], file)}:${i + 1}: ${line.trim()}`)
          })
        }
        expect(offenders).toEqual([])
      })
    })
  }
})
