import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AC-2 (architecture): no template names a vendor, imports a vendor SDK or reads a vendor variable. Over every source
// file and package.json of both templates and of their scaffold copies: no `@stripe/` package, no js.stripe.com, and
// no `*_STRIPE_*` or `*_PAYMENTS_PROVIDER` variable. The payment step comes from the payments adapter's client half
// through a driver the SDK holds.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

const ROOTS = [
  'templates/astro',
  'templates/nextjs',
  'packages/create-app/scaffold/templates/astro',
  'packages/create-app/scaffold/templates/nextjs',
] as const

/** Build output, installs, and the templates' own tests (which drive a fake Stripe.js on purpose). */
const SKIP_DIRS = new Set(['node_modules', '.next', '.astro', 'dist', 'tests', '.turbo'])
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|astro)$/

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'a @stripe/ package', pattern: /@stripe\// },
  { name: 'js.stripe.com', pattern: /js\.stripe\.com/ },
  { name: 'a *_STRIPE_* variable', pattern: /\b[A-Z][A-Z0-9]*_STRIPE_[A-Z0-9_]+\b/ },
  { name: 'a *_PAYMENTS_PROVIDER variable', pattern: /\b[A-Z][A-Z0-9_]*_PAYMENTS_PROVIDER\b/ },
]

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...filesUnder(path))
    } else if (SOURCE.test(name) || name === 'package.json') {
      out.push(path)
    }
  }
  return out
}

describe('templates consume capabilities, not vendors', () => {
  const scanned = ROOTS.map((root) => ({
    root,
    files: filesUnder(join(REPO, root)).map((path) => relative(REPO, path)),
  }))

  it('AC-2: no template source or package.json (scaffold copies included) names @stripe/, js.stripe.com, or a *_STRIPE_* or *_PAYMENTS_PROVIDER variable', () => {
    // The scan reaches every template and scaffold copy, and each one's checkout and package.json.
    for (const { root, files } of scanned) {
      expect(files.length, root).toBeGreaterThan(10)
      expect(files, root).toContain(`${root}/package.json`)
      expect(
        files.some((f) => /checkout/i.test(f)),
        `${root} has a checkout source`,
      ).toBe(true)
    }
    const found: string[] = []
    for (const { files } of scanned) {
      for (const file of files) {
        const lines = readFileSync(join(REPO, file), 'utf8').split('\n')
        lines.forEach((line, i) => {
          for (const rule of RULES) {
            if (rule.pattern.test(line))
              found.push(`${file}:${i + 1}: ${rule.name}: ${line.trim()}`)
          }
        })
      }
    }

    expect(found).toEqual([])
  })
})
