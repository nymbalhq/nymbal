import { readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectPackageManager, scaffold } from '../src/index.js'
import {
  NYMBAL_PACKAGE_DIRS,
  NON_SCAFFOLD_PACKAGES,
  main as syncScaffold,
  mergePackageJson,
  readNymbalVersions,
  rewriteWorkspaceVersions,
  shouldCopyScaffoldEntry,
} from '../scripts/sync-scaffold.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SCAFFOLD_TEMPLATES = resolve(PKG_ROOT, 'scaffold', 'templates')
const MONOREPO_ROOT = resolve(PKG_ROOT, '..', '..')
const PACKAGES_DIR = resolve(MONOREPO_ROOT, 'packages')

// ─── detectPackageManager ────────────────────────────────────────────────────

describe('detectPackageManager', () => {
  const orig = process.env['npm_config_user_agent']
  afterAll(() => {
    if (orig === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = orig
  })

  it('returns npm when env var is unset', () => {
    delete process.env['npm_config_user_agent']
    expect(detectPackageManager()).toBe('npm')
  })

  it('detects npm', () => {
    process.env['npm_config_user_agent'] = 'npm/10.2.4 node/v22.0.0 darwin arm64 workspaces/false'
    expect(detectPackageManager()).toBe('npm')
  })

  it('detects pnpm', () => {
    process.env['npm_config_user_agent'] = 'pnpm/9.12.3 npm/? node/v22.0.0 darwin arm64'
    expect(detectPackageManager()).toBe('pnpm')
  })

  it('detects bun', () => {
    process.env['npm_config_user_agent'] = 'bun/1.1.34 npm/? node/v22.0.0 darwin arm64'
    expect(detectPackageManager()).toBe('bun')
  })

  it('detects yarn classic (1.x)', () => {
    process.env['npm_config_user_agent'] = 'yarn/1.22.22 npm/? node/v22.0.0 darwin arm64'
    expect(detectPackageManager()).toBe('yarn-classic')
  })

  it('detects yarn berry (2+)', () => {
    process.env['npm_config_user_agent'] = 'yarn/3.6.0 npm/? node/v22.0.0 darwin arm64'
    expect(detectPackageManager()).toBe('yarn-berry')
  })

  it('detects yarn berry (4.x)', () => {
    process.env['npm_config_user_agent'] = 'yarn/4.1.0 npm/? node/v22.0.0 darwin arm64'
    expect(detectPackageManager()).toBe('yarn-berry')
  })
})

// ─── sync-scaffold: rewriteWorkspaceVersions ─────────────────────────────────

describe('rewriteWorkspaceVersions', () => {
  const versions = { '@nymbal/foo': '1.2.3', '@nymbal/bar': '0.5.0' }

  it('rewrites workspace:* to ^version', () => {
    const result = rewriteWorkspaceVersions({ '@nymbal/foo': 'workspace:*' }, versions)
    expect(result).toEqual({ '@nymbal/foo': '^1.2.3' })
  })

  it('throws when workspace:* key has no version entry', () => {
    expect(() =>
      rewriteWorkspaceVersions({ '@nymbal/unknown': 'workspace:*' }, versions),
    ).toThrow(/NYMBAL_PACKAGE_DIRS/)
  })

  it('leaves non-workspace:* values untouched', () => {
    const result = rewriteWorkspaceVersions(
      { astro: '^4.0.0', '@nymbal/foo': 'workspace:*' },
      versions,
    )
    expect(result).toEqual({ astro: '^4.0.0', '@nymbal/foo': '^1.2.3' })
  })

  it('returns undefined unchanged', () => {
    expect(rewriteWorkspaceVersions(undefined, versions)).toBeUndefined()
  })
})

// ─── sync-scaffold: mergePackageJson ─────────────────────────────────────────

describe('mergePackageJson', () => {
  const versions = {
    '@nymbal/cli': '0.1.0',
    '@nymbal/config': '0.1.0',
    '@nymbal/platform': '0.1.0',
    '@nymbal/sdk': '0.1.0',
    '@nymbal/types': '0.1.0',
    '@nymbal/web-components': '0.1.0',
  }

  const templatePkg = {
    name: '@nymbal/template-astro',
    version: '0.1.0',
    private: true,
    license: 'MIT',
    type: 'module',
    engines: { node: '>=22' },
    scripts: {
      dev: 'astro dev --port 4321',
      build: 'astro build',
    },
    dependencies: {
      astro: '^4.16.7',
      '@nymbal/sdk': 'workspace:*',
      '@nymbal/types': 'workspace:*',
      '@nymbal/web-components': 'workspace:*',
    },
  }

  it('injects migrate and seed scripts', () => {
    const merged = mergePackageJson(templatePkg, versions)
    expect((merged.scripts as Record<string, string>)['migrate']).toBe('nymbal migrate')
    expect((merged.scripts as Record<string, string>)['seed']).toBe('nymbal seed')
  })

  it('preserves framework-native scripts', () => {
    const merged = mergePackageJson(templatePkg, versions)
    expect((merged.scripts as Record<string, string>)['dev']).toBe('astro dev --port 4321')
    expect((merged.scripts as Record<string, string>)['build']).toBe('astro build')
  })

  it('injects root-manifest deps', () => {
    const merged = mergePackageJson(templatePkg, versions)
    const deps = merged.dependencies as Record<string, string>
    expect(deps['@nymbal/cli']).toBe('^0.1.0')
    expect(deps['@nymbal/config']).toBe('^0.1.0')
    expect(deps['@nymbal/platform']).toBe('^0.1.0')
  })

  it('rewrites workspace:* template deps', () => {
    const merged = mergePackageJson(templatePkg, versions)
    const deps = merged.dependencies as Record<string, string>
    expect(deps['@nymbal/sdk']).toBe('^0.1.0')
    expect(deps['@nymbal/web-components']).toBe('^0.1.0')
  })

  it('deduplicates @nymbal/types (template wins)', () => {
    const merged = mergePackageJson(templatePkg, versions)
    const deps = merged.dependencies as Record<string, string>
    // types appears in both root-manifest (via injected rootDeps if added) and template — just once
    const typeEntries = Object.keys(deps).filter((k) => k === '@nymbal/types')
    expect(typeEntries).toHaveLength(1)
  })

  it('sanitizes description', () => {
    const merged = mergePackageJson(templatePkg, versions)
    expect(merged.description).toBe('A Nymbal commerce project')
  })

  it('drops packageManager field', () => {
    const merged = mergePackageJson(templatePkg, versions)
    expect(merged).not.toHaveProperty('packageManager')
  })
})

// ─── NYMBAL_PACKAGE_DIRS coverage ────────────────────────────────────────────

describe('NYMBAL_PACKAGE_DIRS coverage', () => {
  it('includes every @nymbal/* package directory under packages/', async () => {
    const all = await readdir(PACKAGES_DIR, { withFileTypes: true })
    const nymbalDirs = (
      await Promise.all(
        all
          .filter((e) => e.isDirectory())
          .map(async (e) => {
            try {
              const pkg = JSON.parse(
                await readFile(resolve(PACKAGES_DIR, e.name, 'package.json'), 'utf8'),
              ) as { name?: string }
              return pkg.name?.startsWith('@nymbal/') ? pkg.name : null
            } catch {
              return null
            }
          }),
      )
    ).filter(Boolean) as string[]

    const covered = new Set(NYMBAL_PACKAGE_DIRS.map((d: { name: string }) => d.name))
    // Packages in NON_SCAFFOLD_PACKAGES are intentionally absent (dev/testing-only packages)
    const missing = nymbalDirs.filter((n) => !covered.has(n) && !NON_SCAFFOLD_PACKAGES.has(n))
    expect(missing).toEqual([])
  })
})

// ─── scaffold/templates output assertions ────────────────────────────────────

describe('scaffold/templates built output', () => {
  it('astro and nextjs scaffold directories exist (run pnpm build first)', () => {
    expect(existsSync(resolve(SCAFFOLD_TEMPLATES, 'astro'))).toBe(true)
    expect(existsSync(resolve(SCAFFOLD_TEMPLATES, 'nextjs'))).toBe(true)
  })

  for (const tmpl of ['astro', 'nextjs'] as const) {
    describe(`${tmpl} package.json`, () => {
      let pkg: Record<string, unknown>

      beforeAll(async () => {
        const raw = await readFile(resolve(SCAFFOLD_TEMPLATES, tmpl, 'package.json'), 'utf8')
        pkg = JSON.parse(raw) as Record<string, unknown>
      })

      it('has no workspace:* references', () => {
        const content = JSON.stringify(pkg)
        expect(content).not.toContain('workspace:')
      })

      it('has migrate and seed scripts', () => {
        const scripts = pkg['scripts'] as Record<string, string>
        expect(scripts['migrate']).toBe('nymbal migrate')
        expect(scripts['seed']).toBe('nymbal seed')
      })

      it('all @nymbal/* deps match semver range', () => {
        const deps = pkg['dependencies'] as Record<string, string>
        for (const [key, val] of Object.entries(deps)) {
          if (key.startsWith('@nymbal/')) {
            expect(val).toMatch(/^\^\d+\.\d+\.\d+/)
          }
        }
      })

      it('all @nymbal/* versions are equal (version cohort consistency)', () => {
        const deps = pkg['dependencies'] as Record<string, string>
        const nymbalVersions = Object.entries(deps)
          .filter(([k]) => k.startsWith('@nymbal/'))
          .map(([, v]) => v)
        const unique = new Set(nymbalVersions)
        expect(unique.size).toBe(1)
      })

      it('description is the generic project description', () => {
        expect(pkg['description']).toBe('A Nymbal commerce project')
      })

      it('has no packageManager field', () => {
        expect(pkg).not.toHaveProperty('packageManager')
      })
    })
  }

  it('astro has framework-native scripts (dev, build, preview)', async () => {
    const raw = await readFile(resolve(SCAFFOLD_TEMPLATES, 'astro', 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts: Record<string, string> }
    expect(pkg.scripts['dev']).toContain('astro')
    expect(pkg.scripts['build']).toContain('astro')
    expect(pkg.scripts['preview']).toContain('astro')
  })

  it('nextjs has framework-native scripts (dev, build, start)', async () => {
    const raw = await readFile(resolve(SCAFFOLD_TEMPLATES, 'nextjs', 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts: Record<string, string> }
    expect(pkg.scripts['dev']).toContain('next')
    expect(pkg.scripts['build']).toContain('next')
    expect(pkg.scripts['start']).toContain('next')
  })
})

// ─── scaffold() integration tests ────────────────────────────────────────────

describe('scaffold() output', () => {
  const tmpBase = resolve(PKG_ROOT, 'test', '.tmp-scaffold')

  afterAll(async () => {
    await rm(tmpBase, { recursive: true, force: true })
  })

  async function run(template: 'astro' | 'nextjs', dirSuffix: string) {
    const dir = resolve(tmpBase, dirSuffix)
    await scaffold(dir, {
      name: 'Test Store',
      directory: dirSuffix,
      currency: 'GBP',
      template,
      seedDemo: false,
      includeMobile: false,
    })
    return dir
  }

  for (const tmpl of ['astro', 'nextjs'] as const) {
    describe(tmpl, () => {
      let outDir: string

      beforeAll(async () => {
        outDir = await run(tmpl, `test-${tmpl}`)
      })

      it('produces flat layout (no storefront/ subdir)', () => {
        expect(existsSync(resolve(outDir, 'storefront'))).toBe(false)
      })

      it('does not emit pnpm-workspace.yaml', () => {
        expect(existsSync(resolve(outDir, 'pnpm-workspace.yaml'))).toBe(false)
      })

      it('patches package.json name to project directory', async () => {
        const pkg = JSON.parse(
          await readFile(resolve(outDir, 'package.json'), 'utf8'),
        ) as { name: string }
        expect(pkg.name).toBe(`test-${tmpl}`)
      })

      it('has no workspace:* anywhere in output', async () => {
        const check = async (dirPath: string): Promise<void> => {
          const entries = await readdir(dirPath, { withFileTypes: true })
          for (const e of entries) {
            if (e.name === 'node_modules') continue
            const full = resolve(dirPath, e.name)
            if (e.isDirectory()) {
              await check(full)
            } else if (e.name.endsWith('.json') || e.name.endsWith('.ts') || e.name.endsWith('.mjs')) {
              const content = await readFile(full, 'utf8')
              expect(content, `workspace:* found in ${full}`).not.toContain('workspace:')
            }
          }
        }
        await check(outDir)
      })

      it('nymbal.config.ts contains the chosen currency', async () => {
        const config = await readFile(resolve(outDir, 'nymbal.config.ts'), 'utf8')
        expect(config).toContain("currency: 'GBP'")
      })

      it('has .gitignore at root (renamed from _dot.gitignore)', () => {
        expect(existsSync(resolve(outDir, '.gitignore'))).toBe(true)
        expect(existsSync(resolve(outDir, '_dot.gitignore'))).toBe(false)
      })

      it('has .env.example at root (renamed from _dot.env.example)', () => {
        expect(existsSync(resolve(outDir, '.env.example'))).toBe(true)
        expect(existsSync(resolve(outDir, '_dot.env.example'))).toBe(false)
      })
    })
  }
})

// ─── sync-scaffold: shouldCopyScaffoldEntry (filter regression) ──────────────
//
// Regression guard for the filter bug that shipped a scaffold with ZERO .astro
// page files: the old filter used src.endsWith('.astro'), which excluded every
// *.astro FILE instead of just the .astro cache DIRECTORY.

describe('shouldCopyScaffoldEntry', () => {
  it('rejects the .astro cache directory (exact basename)', () => {
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/.astro')).toBe(false)
  })

  it('accepts .astro page files (the old endsWith filter wrongly rejected these)', () => {
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/src/pages/index.astro')).toBe(true)
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/src/pages/cart.astro')).toBe(true)
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/src/components/ProductCard.astro')).toBe(
      true,
    )
  })

  it('rejects node_modules, dist and .next directories by exact basename', () => {
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/node_modules')).toBe(false)
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/dist')).toBe(false)
    expect(shouldCopyScaffoldEntry('/repo/templates/nextjs/.next')).toBe(false)
  })

  it('rejects *.tsbuildinfo files', () => {
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/tsconfig.tsbuildinfo')).toBe(false)
  })

  it('accepts files whose names merely contain an excluded name', () => {
    // next.config.mjs basename is not ".next"; the old endsWith hazard is gone
    expect(shouldCopyScaffoldEntry('/repo/templates/nextjs/next.config.mjs')).toBe(true)
    expect(shouldCopyScaffoldEntry('/repo/templates/astro/src/lib/distance.ts')).toBe(true)
  })
})

// ─── sync-scaffold: main() integration ───────────────────────────────────────

describe('syncScaffold main() integration', () => {
  const tmpDest = resolve(PKG_ROOT, 'test', '.tmp-sync')

  beforeAll(async () => {
    await rm(tmpDest, { recursive: true, force: true })
    await syncScaffold(tmpDest)
  })

  afterAll(async () => {
    await rm(tmpDest, { recursive: true, force: true })
  })

  it('copies .astro page files into the synced astro scaffold', async () => {
    const index = await readFile(resolve(tmpDest, 'astro', 'src', 'pages', 'index.astro'), 'utf8')
    expect(index).toContain('<HeroSection')

    const cart = await readFile(resolve(tmpDest, 'astro', 'src', 'pages', 'cart.astro'), 'utf8')
    expect(cart.length).toBeGreaterThan(0)
  })

  it('copies .astro layout and component files', () => {
    expect(existsSync(resolve(tmpDest, 'astro', 'src', 'layouts', 'BaseLayout.astro'))).toBe(true)
    expect(existsSync(resolve(tmpDest, 'astro', 'src', 'components', 'ProductCard.astro'))).toBe(
      true,
    )
  })

  it('does not copy the .astro cache dir, node_modules or dist', () => {
    expect(existsSync(resolve(tmpDest, 'astro', '.astro'))).toBe(false)
    expect(existsSync(resolve(tmpDest, 'astro', 'node_modules'))).toBe(false)
    expect(existsSync(resolve(tmpDest, 'astro', 'dist'))).toBe(false)
    expect(existsSync(resolve(tmpDest, 'nextjs', 'node_modules'))).toBe(false)
    expect(existsSync(resolve(tmpDest, 'nextjs', '.next'))).toBe(false)
  })

  it('rewrites workspace:* in the synced package.json', async () => {
    const pkg = await readFile(resolve(tmpDest, 'astro', 'package.json'), 'utf8')
    expect(pkg).not.toContain('workspace:')
  })

  it('never touches the project-layer overrides (scaffold/project is outside the sync root)', () => {
    // sync-scaffold rm -rf's only <destRoot>/<template>. The shipped override must
    // survive every sync — it is the source of the project layer, not synced output.
    expect(
      existsSync(resolve(PKG_ROOT, 'scaffold', 'project', 'astro', 'src', 'pages', 'index.astro')),
    ).toBe(true)
  })
})

// ─── override resolution: project layer wins ─────────────────────────────────

describe('override resolution (project layer wins)', () => {
  const tmpBase = resolve(PKG_ROOT, 'test', '.tmp-override')
  const templateDefaultIndex = resolve(
    SCAFFOLD_TEMPLATES,
    'astro',
    'src',
    'pages',
    'index.astro',
  )
  let outDir: string

  beforeAll(async () => {
    // Fail loudly (never skip) if the synced scaffold is stale or missing —
    // the override guard is meaningless against a stale scaffold.
    if (!existsSync(templateDefaultIndex)) {
      throw new Error(
        `Synced scaffold is stale: ${templateDefaultIndex} is missing. ` +
          'Run "pnpm --filter create-nymbal-app build" before running these tests.',
      )
    }
    await rm(tmpBase, { recursive: true, force: true })
    outDir = resolve(tmpBase, 'override-astro')
    await scaffold(outDir, {
      name: 'Override Store',
      directory: 'override-astro',
      currency: 'GBP',
      template: 'astro',
      seedDemo: false,
      includeMobile: false,
    })
  })

  afterAll(async () => {
    await rm(tmpBase, { recursive: true, force: true })
  })

  it('scaffolded homepage contains the project-override marker (project layer won)', async () => {
    const index = await readFile(resolve(outDir, 'src', 'pages', 'index.astro'), 'utf8')
    expect(index).toContain('nymbal:project-override homepage')
  })

  it('scaffolded homepage differs from the template default', async () => {
    const scaffolded = await readFile(resolve(outDir, 'src', 'pages', 'index.astro'), 'utf8')
    const templateDefault = await readFile(templateDefaultIndex, 'utf8')
    expect(scaffolded).not.toBe(templateDefault)
    // The template default must NOT carry the override marker — otherwise this
    // test could pass even if the template layer (not the project layer) won.
    expect(templateDefault).not.toContain('nymbal:project-override')
  })

  it('non-overridden pages are byte-identical to the template default', async () => {
    const scaffoldedCart = await readFile(resolve(outDir, 'src', 'pages', 'cart.astro'), 'utf8')
    const templateCart = await readFile(
      resolve(SCAFFOLD_TEMPLATES, 'astro', 'src', 'pages', 'cart.astro'),
      'utf8',
    )
    expect(scaffoldedCart).toBe(templateCart)
  })

  it('scaffolded project actually contains .astro pages (filter bug regression)', () => {
    for (const page of ['index.astro', 'cart.astro', 'checkout.astro', 'search.astro']) {
      expect(existsSync(resolve(outDir, 'src', 'pages', page)), `missing src/pages/${page}`).toBe(
        true,
      )
    }
  })

  it('override homepage keeps the smoke-check and E2E markers intact', async () => {
    const index = await readFile(resolve(outDir, 'src', 'pages', 'index.astro'), 'utf8')
    // tools/scaffold-smoke-check.mjs greps served HTML for "hero-section" and
    // "product-card-" — the override must keep rendering both components.
    expect(index).toContain('<HeroSection')
    expect(index).toContain('<ProductCard')
  })
})

// ─── readNymbalVersions ───────────────────────────────────────────────────────

describe('readNymbalVersions', () => {
  it('returns a version string for every entry in NYMBAL_PACKAGE_DIRS', async () => {
    const versions = await readNymbalVersions()
    for (const { name } of NYMBAL_PACKAGE_DIRS) {
      expect(typeof versions[name]).toBe('string')
      expect(versions[name]).toMatch(/^\d+\.\d+\.\d+/)
    }
  })
})
